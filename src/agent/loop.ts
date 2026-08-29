import {
  type AssistantMessage,
  type Context,
  type Message,
  type ThinkingLevel,
  type ToolCall,
  isContextOverflow,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import type { DurableRecord, SessionEntry, Turn } from "../domain.js";
import type { ExtensionEvents } from "../extensions/events.js";
import type { VersionService } from "../revisions/version-service.js";
import { squashMessage, type BuiltSessionContext, type SessionService } from "../session/service.js";
import type { AgentTool, ToolRegistry, ToolResult } from "../tools/types.js";
import type { AskPresenter } from "../ui/ask.js";
import { safeUiEvent, type UiEventSink } from "../ui/events.js";
import { createId } from "../utils/id.js";
import { estimateContextTokens } from "../utils/estimate.js";
import {
  CONTEXT_SAFETY_TOKENS,
  ContextCompactor,
  formatWorkspaceDiffStat,
  type RootSquashDraft,
} from "./compaction.js";
import type { ModelClient } from "./model-client.js";

export const DEFAULT_SYSTEM_PROMPT = `You are thread, a coding agent working in a long-lived Session Tree. Use the provided tools to inspect and modify the workspace. Keep changes scoped to the user's request and verify important edits. When answering or reporting results, lower the information density without omitting useful information. Add context when helpful, use natural transitions, and explain complex ideas clearly and at a measured pace.

The Session Tree is this project's memory, and it extends past what you can currently see: earlier turns may have been compacted away, left on a branch that was later rewound, or simply happened before your live context began. When a question turns on something said or decided earlier that you cannot find in the current context, search that memory rather than answering from the visible context alone or telling the user you do not recall.`;

export interface AgentLoopOptions {
  systemPrompt?: string;
  maxOutputTokens?: number;
  reasoning?: ThinkingLevel;
  /**
   * Resolves the interactive question channel at call time. Read per tool call
   * rather than captured, because a front end attaches and detaches over a
   * runtime's life while the loop instance stays put.
   */
  askPresenter?: () => AskPresenter | undefined;
}

export interface RunTurnOptions {
  signal: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onUiEvent?: UiEventSink;
}

export interface TurnResult {
  turn: Turn;
  outcome: "completed" | "aborted" | "failed";
  messages: AssistantMessage[];
  error?: Error;
}

export interface ManualCompactionResult {
  compacted: boolean;
  checkpointId?: string;
  summarizedMessages?: number;
  retainedMessages?: number;
  modelCalls?: number;
}

export class AgentLoop {
  private readonly systemPrompt: string;
  private readonly maxOutputTokens: number;
  private readonly reasoning: ThinkingLevel | undefined;
  private readonly askPresenter: (() => AskPresenter | undefined) | undefined;
  private readonly compactor: ContextCompactor;

  constructor(
    private readonly rootPath: string,
    private readonly model: ModelClient,
    private readonly session: SessionService,
    private readonly versions: VersionService,
    private readonly tools: ToolRegistry,
    private readonly extensions: ExtensionEvents,
    options: AgentLoopOptions = {},
  ) {
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.maxOutputTokens =
      options.maxOutputTokens ??
      Math.min(model.maxOutputTokens, 16_384, Math.max(1_024, Math.floor(model.contextWindow * 0.2)));
    this.reasoning = options.reasoning;
    this.askPresenter = options.askPresenter;
    this.compactor = new ContextCompactor(session, model, {
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    });
  }

  async compactCurrent(options: RunTurnOptions): Promise<ManualCompactionResult> {
    this.versions.requireIdle();
    const branchName = this.versions.currentBranch.name;
    const checkpointId = this.versions.head.id;
    const sourceHeadId = this.session.projection.lanes.get(branchName) ?? null;
    const built = this.session.buildContext(sourceHeadId);
    const operationId = createId("operation");
    const resultEntryId = createId("entry");
    const manualContext = (await this.extensions.emit("before_context", {
      turnId: operationId,
      context: {
        systemPrompt: this.systemPrompt,
        messages: built.messages,
        tools: this.tools.modelDefinitions(),
      } satisfies Context,
    })).context;
    const budget = this.estimateCompactionBudget(manualContext, built.messages);
    const workspaceDiffStat = await this.projectWorkspaceDiffStat(this.versions.head.workspaceTreeOid);
    const diffTokens = estimateContextTokens([
      { role: "user", content: workspaceDiffStat, timestamp: Number.MAX_SAFE_INTEGER },
    ]).tokens;
    const retainedTailBudget = this.compactor.retainedTailBudget(budget.overheadTokens, diffTokens);
    if (!this.compactor.canCompact(built, retainedTailBudget)) return { compacted: false };

    await this.session.appendRecord(
      {
        id: operationId,
        type: "operation_started",
        lane: branchName,
        sourceLeafId: sourceHeadId,
        intent: { kind: "compaction", resultEntryId },
      },
      true,
    );
    const observer = {
      started: (reason: "manual" | "threshold" | "overflow") =>
        safeUiEvent(options.onUiEvent, { type: "compaction_started", reason }),
      finished: (ok: boolean) => safeUiEvent(options.onUiEvent, { type: "compaction_finished", ok }),
    };
    try {
      observer.started("manual");
      await this.session.appendRecord({
        id: createId("record"),
        type: "step_attempt",
        lane: branchName,
        runId: operationId,
        step: "compaction",
        attempt: 1,
        resultEntryId,
        compactionReason: "compact_command",
      }, true);
      const draft = await this.compactor.createProjectStateDraft({
        built,
        requestTokensBefore: budget.requestTokens,
        retainedTailBudgetTokens: retainedTailBudget,
        workspaceDiffStat,
        signal: options.signal,
        forkContext: manualContext,
      });
      if (!draft) throw new Error("Context became ineligible for squash");
      this.assertSquashedRequestFits(draft, budget.overheadTokens, resultEntryId);
      this.validateFrozenState(branchName, checkpointId, sourceHeadId);
      await this.compactor.appendDraft(branchName, null, sourceHeadId, draft, resultEntryId);
      const checkpoint = await this.versions.finishCompaction(operationId, branchName, {
        squashEntryCount: draft.summarizedEntries,
        squashTurnCount: draft.summarizedTurns,
      });
      observer.finished(true);
      return {
        compacted: true,
        checkpointId: checkpoint.id,
        summarizedMessages: draft.summarizedMessages,
        retainedMessages: draft.retainedMessages,
        modelCalls: draft.modelCalls,
      };
    } catch (error) {
      observer.finished(false);
      // Once the result entry is durable, leave the operation open: startup
      // recovery will attach that context leaf to a checkpoint. Before that
      // point it is safe to close the failed operation directly.
      if (!this.session.projection.entries.has(resultEntryId)) {
        await this.session.appendRecord(
          {
            id: createId("record"),
            type: "operation_finished",
            lane: branchName,
            runId: operationId,
            outcome: options.signal.aborted ? "aborted" : "failed",
            error: {
              code: error instanceof Error ? error.name || "error" : "error",
              message: error instanceof Error ? error.message : String(error),
            },
          },
          true,
        );
      }
      throw error;
    }
  }

  async squashFrom(turnIdOrEntryId: string, options: RunTurnOptions): Promise<TurnResult> {
    this.versions.requireIdle();
    const branchName = this.versions.currentBranch.name;
    const checkpointId = this.versions.head.id;
    const sourceHeadId = this.session.projection.lanes.get(branchName) ?? null;
    const pathIds = new Set(this.session.pathTo(sourceHeadId).map((entry) => entry.id));
    const candidates = [...this.session.projection.turns.values()].filter((turn) => {
      if (!pathIds.has(turn.userEntryId)) return false;
      const entry = this.session.projection.entries.get(turn.userEntryId);
      if (entry?.type !== "message" || entry.message.role !== "user") return false;
      return turn.id === turnIdOrEntryId || turn.userEntryId === turnIdOrEntryId ||
        turn.id.startsWith(turnIdOrEntryId) || turn.userEntryId.startsWith(turnIdOrEntryId);
    });
    if (candidates.length !== 1) throw new Error(`Could not uniquely resolve a current-path user turn: ${turnIdOrEntryId}`);
    const selectedTurn = candidates[0]!;
    const selectedEntry = this.session.projection.entries.get(selectedTurn.userEntryId)!;
    if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
      throw new Error("Squash target must be a real user message");
    }

    const turnId = createId("turn");
    const assembled = await this.assembleContext(branchName, turnId);
    const budget = this.estimateCompactionBudget(assembled.context, assembled.sessionMessages);
    const draft = await this.compactor.createIncrementalDraft({
      built: assembled.built,
      selectedUserEntryId: selectedEntry.id,
      requestTokensBefore: budget.requestTokens,
      workspaceDiffStat: "",
      signal: options.signal,
      forkContext: assembled.context,
    });
    this.validateFrozenState(branchName, checkpointId, sourceHeadId);

    const pendingBase = this.versions.startTurnBaseCapture();
    void pendingBase.completion.catch(() => undefined);
    const turnBase = await pendingBase.completion;
    this.validateFrozenState(branchName, turnBase.id, sourceHeadId);
    const selectedBase = this.versions.getCheckpoint(selectedTurn.baseCheckpointId);
    draft.workspaceDiffStat = formatWorkspaceDiffStat(
      await this.versions.workspace.diffTrees(selectedBase.workspaceTreeOid, turnBase.workspaceTreeOid),
    );
    this.validateFrozenState(branchName, turnBase.id, sourceHeadId);

    const operationId = createId("operation");
    const squashEntryId = createId("entry");
    const startedAt = Date.now();
    const rendered = squashMessage({
      id: squashEntryId,
      sessionId: this.session.store.sessionId,
      seq: this.session.projection.nextSequence,
      parentId: selectedEntry.parentId,
      timestamp: startedAt,
      type: "squash",
      summaryKind: "incremental",
      summary: draft.summary,
      workspaceDiffStat: draft.workspaceDiffStat,
      retainedTail: [],
      requestTokensBefore: draft.requestTokensBefore,
    });
    const parentContext = this.session.buildContext(selectedEntry.parentId).messages;
    const marker: Message = { role: "user", content: "", timestamp: Number.MAX_SAFE_INTEGER };
    const projectedSessionTokens = estimateContextTokens([marker, ...parentContext, rendered]).tokens;
    const projectedRequestTokens = projectedSessionTokens + budget.overheadTokens;
    if (projectedRequestTokens + this.maxOutputTokens + CONTEXT_SAFETY_TOKENS > this.model.contextWindow) {
      throw new Error("Squashed turn still cannot fit safely in the current model context; use /clear or /rewind");
    }

    await this.session.appendRecord({
      id: operationId,
      type: "operation_started",
      lane: branchName,
      sourceLeafId: sourceHeadId,
      intent: { kind: "run", originalPrompt: [rendered], initialEntryIds: [squashEntryId] },
    }, true);
    const squashEntry = await this.compactor.appendDraft(
      branchName,
      selectedEntry.parentId,
      sourceHeadId,
      draft,
      squashEntryId,
      startedAt,
    );
    const turn: Turn = {
      id: turnId,
      sessionId: this.session.store.sessionId,
      branchName,
      userEntryId: squashEntry.id,
      baseCheckpointId: turnBase.id,
      resultCheckpointId: null,
      outcome: "running",
      startedAt,
    };
    await this.versions.persistSquashCheckpoint({
      branchName,
      expectedHeadCheckpointId: turnBase.id,
      sessionHeadId: squashEntry.id,
      details: {
        squashFromEntryId: selectedEntry.id,
        squashSourceHeadId: sourceHeadId,
        squashTrigger: "thread_command",
        squashEntryCount: draft.summarizedEntries,
        squashTurnCount: draft.summarizedTurns,
      },
      extraEvents: () => [{ type: "turn_started", turn }],
    });
    const excerpt = typeof selectedEntry.message.content === "string"
      ? selectedEntry.message.content.replace(/\s+/g, " ").slice(0, 120)
      : "selected user turn";
    const displayInput = `session squashed from: ${excerpt}`;
    const syntheticInput = typeof rendered.content === "string" ? rendered.content : displayInput;
    safeUiEvent(options.onUiEvent, {
      type: "turn_started",
      turnId,
      userEntryId: squashEntry.id,
      input: displayInput,
      branch: branchName,
      syntheticSquash: true,
    });
    return this.executePreparedTurn({
      turn,
      operationId,
      input: syntheticInput,
      turnReady: Promise.resolve(turn),
      runSignal: options.signal,
      sourceLeafId: sourceHeadId,
      preparationFailure: () => undefined,
      options,
    });
  }

  async run(input: string, options: RunTurnOptions): Promise<TurnResult> {
    if (!input.trim()) throw new Error("User message cannot be empty");
    const base = this.versions.startTurnBaseCapture();
    // The capture can fail before the two required durable appends below have
    // completed. Observe it immediately; turnReady handles and reports the same
    // rejection once the prepared operation exists.
    void base.completion.catch(() => undefined);
    const branchName = base.branchName;
    const operationId = createId("operation");
    const userEntryId = createId("entry");
    const turnId = createId("turn");
    const startedAt = Date.now();
    const originalMessage: Message = { role: "user", content: input, timestamp: startedAt };
    await this.session.appendRecord(
      {
        id: operationId,
        type: "operation_started",
        lane: branchName,
        sourceLeafId: base.sessionHeadId,
        intent: { kind: "run", originalPrompt: [originalMessage], initialEntryIds: [userEntryId] },
      },
      true,
    );
    const userEntry = await this.session.appendEntry(
      branchName,
      { id: userEntryId, sessionId: this.session.store.sessionId, type: "message", message: originalMessage },
      true,
    );
    const turn: Turn = {
      id: turnId,
      sessionId: this.session.store.sessionId,
      branchName,
      userEntryId: userEntry.id,
      baseCheckpointId: base.id,
      resultCheckpointId: null,
      outcome: "running",
      startedAt,
    };
    const preparationAbort = new AbortController();
    let preparationFailure: Error | undefined;
    const turnReady = base.completion.then(async (checkpoint) => {
      if (checkpoint.id !== turn.baseCheckpointId) throw new Error("Turn base checkpoint changed during capture");
      await this.session.store.append(() => ({ type: "turn_started", turn }), { flush: true });
      return turn;
    });
    void turnReady.catch((error) => {
      preparationFailure = error instanceof Error ? error : new Error(String(error));
      preparationAbort.abort(preparationFailure);
    });
    const runSignal = AbortSignal.any([options.signal, preparationAbort.signal]);
    safeUiEvent(options.onUiEvent, {
      type: "turn_started",
      turnId,
      userEntryId: userEntry.id,
      input,
      branch: branchName,
    });

    return this.executePreparedTurn({
      turn,
      operationId,
      input,
      turnReady,
      runSignal,
      sourceLeafId: base.sessionHeadId,
      preparationFailure: () => preparationFailure,
      options,
    });
  }

  private async executePreparedTurn(prepared: {
    turn: Turn;
    operationId: string;
    input: string;
    turnReady: Promise<Turn>;
    runSignal: AbortSignal;
    sourceLeafId: string | null;
    preparationFailure: () => Error | undefined;
    options: RunTurnOptions;
  }): Promise<TurnResult> {
    const { turn, operationId, input, turnReady, runSignal, sourceLeafId, options } = prepared;
    const branchName = turn.branchName;
    const assistantMessages: AssistantMessage[] = [];
    let outcome: TurnResult["outcome"] = "completed";
    let failure: Error | undefined;
    try {
      await this.extensions.emit("turn_start", { turnId: turn.id, branch: branchName, input });
      for (let step = 0; ; step++) {
        runSignal.throwIfAborted();
        const compactionObserver = {
          started: (reason: "manual" | "threshold" | "overflow") =>
            safeUiEvent(options.onUiEvent, { type: "compaction_started", reason }),
          finished: (ok: boolean) => safeUiEvent(options.onUiEvent, { type: "compaction_finished", ok }),
        };
        let assembled = await this.assembleContext(branchName, turn.id);
        let budget = this.estimateCompactionBudget(assembled.context, assembled.sessionMessages);
        let compacted = false;
        if (this.compactor.shouldCompact(budget.requestTokens, budget.outputTokens)) {
          await turnReady;
          compacted = await this.squashProjectState(
            branchName,
            operationId,
            assembled,
            budget,
            runSignal,
            "threshold",
            compactionObserver,
          );
        }
        if (compacted) {
          assembled = await this.assembleContext(branchName, turn.id);
          budget = this.estimateCompactionBudget(assembled.context, assembled.sessionMessages);
        }
        const assistantEntryId = createId("entry");
        const stepAttempt = this.session.appendRecord({
          id: createId("record"),
          type: "step_attempt",
          lane: branchName,
          runId: operationId,
          step: "assistant",
          attempt: step + 1,
          resultEntryId: assistantEntryId,
        });
        safeUiEvent(options.onUiEvent, { type: "assistant_started", step: step + 1 });
        const [response] = await Promise.all([this.model.stream(assembled.context, {
          signal: runSignal,
          maxTokens: this.maxOutputTokens,
          ...(this.reasoning ? { reasoning: this.reasoning } : {}),
          onTextDelta: (delta) => {
            options.onTextDelta?.(delta);
            safeUiEvent(options.onUiEvent, { type: "assistant_text_delta", step: step + 1, delta });
          },
          onThinkingDelta: (delta) => {
            safeUiEvent(options.onUiEvent, { type: "assistant_thinking_delta", step: step + 1, delta });
          },
          onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
            safeUiEvent(options.onUiEvent, {
              type: "model_retry_scheduled",
              step: step + 1,
              attempt,
              maxAttempts,
              delayMs,
              errorMessage,
            });
          },
          onRetryAttemptStart: (attempt, maxAttempts) => {
            safeUiEvent(options.onUiEvent, {
              type: "model_retry_started",
              step: step + 1,
              attempt,
              maxAttempts,
            });
          },
        }), turnReady, stepAttempt]);
        assistantMessages.push(response);
        await this.session.appendEntry(
          branchName,
          {
            id: assistantEntryId,
            sessionId: this.session.store.sessionId,
            type: "message",
            message: response,
          },
          true,
        );
        if (response.stopReason === "error" && isContextOverflow(response, this.model.contextWindow)) {
          const overflowContext = await this.assembleContext(branchName, turn.id);
          const overflowBudget = this.estimateCompactionBudget(
            overflowContext.context,
            overflowContext.sessionMessages,
          );
          const recovered = await this.squashProjectState(
            branchName,
            operationId,
            overflowContext,
            overflowBudget,
            runSignal,
            "overflow",
            compactionObserver,
          );
          if (!recovered) {
            throw new Error("Context overflow could not be squashed without splitting the minimum retained turns; use /clear or /rewind");
          }
          continue;
        }
        if (response.stopReason === "aborted") throw new DOMException(response.errorMessage ?? "Aborted", "AbortError");
        if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Model request failed");
        const calls = response.content.filter((content): content is ToolCall => content.type === "toolCall");
        if (calls.length === 0 || response.stopReason !== "toolUse") break;
        for (let toolIndex = 0; toolIndex < calls.length; toolIndex++) {
          await this.runTool(
            branchName,
            operationId,
            assistantEntryId,
            toolIndex,
            calls[toolIndex]!,
            runSignal,
            options.onUiEvent,
          );
        }
      }
    } catch (error) {
      failure = prepared.preparationFailure() ?? (error instanceof Error ? error : new Error(String(error)));
      outcome = options.signal.aborted || failure.name === "AbortError" ? "aborted" : "failed";
    }
    try {
      await turnReady;
    } catch (error) {
      const cause = prepared.preparationFailure() ?? (error instanceof Error ? error : new Error(String(error)));
      await this.abandonUnstartedTurn(branchName, operationId, sourceLeafId, cause, options.signal.aborted);
      throw cause;
    }
    const result = await this.settle(turn, operationId, outcome, assistantMessages, failure);
    safeUiEvent(options.onUiEvent, {
      type: "turn_finished",
      outcome,
      ...(result.turn.resultCheckpointId ? { checkpointId: result.turn.resultCheckpointId } : {}),
      ...(failure ? { error: failure.message } : {}),
    });
    if (result.turn.resultCheckpointId) {
      safeUiEvent(options.onUiEvent, {
        type: "head_changed",
        branch: this.versions.currentBranch.name,
        checkpointId: result.turn.resultCheckpointId,
        reason: "turn",
      });
    }
    return result;
  }

  private async abandonUnstartedTurn(
    lane: string,
    operationId: string,
    sourceLeafId: string | null,
    error: Error,
    aborted: boolean,
  ): Promise<void> {
    await this.session.store.appendBatch(
      (seq, timestamp) => [{
        type: "lane_moved",
        lane,
        leafId: sourceLeafId,
      }, {
        type: "record_appended",
        record: {
          id: createId("record"),
          seq,
          timestamp,
          type: "operation_finished",
          lane,
          runId: operationId,
          outcome: aborted ? "aborted" : "failed",
          error: { code: error.name || "error", message: error.message },
        },
      }],
      { flush: true },
    );
  }

  private async assembleContext(
    branchName: string,
    turnId: string,
  ): Promise<{ context: Context; sessionMessages: Message[]; built: BuiltSessionContext }> {
    const built = this.session.buildContext(this.session.projection.lanes.get(branchName) ?? null);
    let context: Context = {
      systemPrompt: this.systemPrompt,
      messages: built.messages,
      tools: this.tools.modelDefinitions(),
    };
    context = (await this.extensions.emit("before_context", { context, turnId })).context;
    return { context, sessionMessages: built.messages, built };
  }

  private async squashProjectState(
    branchName: string,
    operationId: string,
    assembled: { context: Context; sessionMessages: Message[]; built: BuiltSessionContext },
    budget: ReturnType<AgentLoop["estimateCompactionBudget"]>,
    signal: AbortSignal,
    trigger: "threshold" | "overflow",
    observer: { started(reason: "manual" | "threshold" | "overflow"): void; finished(ok: boolean): void },
  ): Promise<boolean> {
    const sourceHeadId = this.session.projection.lanes.get(branchName) ?? null;
    const checkpointId = this.versions.currentBranch.headCheckpointId;
    const checkpoint = this.versions.getCheckpoint(checkpointId);
    const workspaceDiffStat = await this.projectWorkspaceDiffStat(checkpoint.workspaceTreeOid);
    const diffTokens = estimateContextTokens([
      { role: "user", content: workspaceDiffStat, timestamp: Number.MAX_SAFE_INTEGER },
    ]).tokens;
    const retainedTailBudget = this.compactor.retainedTailBudget(budget.overheadTokens, diffTokens);
    if (!this.compactor.canCompact(assembled.built, retainedTailBudget)) return false;

    observer.started(trigger);
    const resultEntryId = createId("entry");
    try {
      await this.session.appendRecord({
        id: createId("record"),
        type: "step_attempt",
        lane: branchName,
        runId: operationId,
        step: "compaction",
        attempt: 1,
        resultEntryId,
        compactionReason: trigger,
      }, true);
      const draft = await this.compactor.createProjectStateDraft({
        built: assembled.built,
        requestTokensBefore: budget.requestTokens,
        retainedTailBudgetTokens: retainedTailBudget,
        workspaceDiffStat,
        signal,
        forkContext: assembled.context,
      });
      if (!draft) return false;
      this.assertSquashedRequestFits(draft, budget.overheadTokens, resultEntryId);
      this.validateFrozenState(branchName, checkpointId, sourceHeadId);
      const entry = await this.compactor.appendDraft(branchName, null, sourceHeadId, draft, resultEntryId);
      await this.versions.persistSquashCheckpoint({
        branchName,
        expectedHeadCheckpointId: checkpointId,
        sessionHeadId: entry.id,
        details: {
          squashFromEntryId: null,
          squashSourceHeadId: sourceHeadId,
          squashTrigger: trigger,
          squashEntryCount: draft.summarizedEntries,
          squashTurnCount: draft.summarizedTurns,
        },
      });
      observer.finished(true);
      return true;
    } catch (error) {
      observer.finished(false);
      throw error;
    }
  }

  private validateFrozenState(branchName: string, checkpointId: string, leafId: string | null): void {
    if (this.versions.currentBranch.name !== branchName) throw new Error("Thread branch changed while generating squash summary");
    const branch = this.session.projection.branches.get(branchName);
    if (branch?.headCheckpointId !== checkpointId) throw new Error("Thread checkpoint changed while generating squash summary");
    if ((this.session.projection.lanes.get(branchName) ?? null) !== leafId) {
      throw new Error("Session path changed while generating squash summary");
    }
  }

  private assertSquashedRequestFits(
    draft: RootSquashDraft,
    overheadTokens: number,
    entryId: string,
  ): void {
    const summaryMessage = squashMessage({
      id: entryId,
      sessionId: this.session.store.sessionId,
      seq: this.session.projection.nextSequence,
      parentId: null,
      timestamp: Date.now(),
      type: "squash",
      summaryKind: "project_state",
      summary: draft.summary,
      workspaceDiffStat: draft.workspaceDiffStat,
      retainedTail: draft.retainedTail,
      requestTokensBefore: draft.requestTokensBefore,
    });
    const marker: Message = { role: "user", content: "", timestamp: Number.MAX_SAFE_INTEGER };
    const sessionTokens = estimateContextTokens([
      marker,
      summaryMessage,
      ...draft.retainedTail.map((retained) => retained.message),
    ]).tokens;
    const requestTokens = sessionTokens + overheadTokens;
    if (requestTokens + this.maxOutputTokens + CONTEXT_SAFETY_TOKENS > this.model.contextWindow) {
      throw new Error(
        "Squashed context still cannot fit safely in the current model window without splitting the minimum retained turns; use /clear or /rewind",
      );
    }
  }

  private async projectWorkspaceDiffStat(toTreeOid: string): Promise<string> {
    const genesis = [...this.session.projection.checkpoints.values()].find(
      (checkpoint) => checkpoint.parentCheckpointIds.length === 0,
    );
    if (!genesis) throw new Error("Session Tree has no genesis checkpoint");
    return formatWorkspaceDiffStat(await this.versions.workspace.diffTrees(genesis.workspaceTreeOid, toTreeOid));
  }

  /**
   * Session messages plus the prefix the model actually receives. The extension
   * `before_context` hook is not applied, so an extension that injects context is
   * not reflected; every caller that can await should prefer the assembled path.
   */
  baseContextFor(messages: Message[]): Context {
    return { systemPrompt: this.systemPrompt, messages, tools: this.tools.modelDefinitions() };
  }

  /**
   * Request cost as the turn loop measures it, for callers that only hold session
   * messages. Reported so the footer and the compaction trigger read the same
   * number: a messages-only estimate silently drops the system prompt and tool
   * schemas, which understates occupancy exactly when no usage block exists yet.
   */
  estimateRequestBudget(messages: Message[]) {
    return this.estimateCompactionBudget(this.baseContextFor(messages), messages);
  }

  private estimateCompactionBudget(context: Context, sessionMessages: Message[]) {
    const estimateMarker: Message = {
      role: "user",
      content: "",
      timestamp: Number.MAX_SAFE_INTEGER,
    };
    const freshRequestTokens = estimateContextTokens({
      ...context,
      messages: [estimateMarker, ...context.messages],
    }).tokens;
    const freshSessionTokens = estimateContextTokens([estimateMarker, ...sessionMessages]).tokens;
    return {
      requestTokens: Math.max(estimateContextTokens(context).tokens, freshRequestTokens),
      outputTokens: this.maxOutputTokens,
      overheadTokens: Math.max(0, freshRequestTokens - freshSessionTokens),
    };
  }

  private async runTool(
    lane: string,
    runId: string,
    assistantEntryId: string,
    toolIndex: number,
    call: ToolCall,
    signal: AbortSignal,
    onUiEvent?: UiEventSink,
  ): Promise<SessionEntry> {
    const tool = this.tools.get(call.name);
    let args = call.arguments as Record<string, unknown>;
    let result: ToolResult | undefined;
    let replay: AgentTool["replay"] = "never";
    if (!tool) {
      result = { content: `Unknown tool: ${call.name}`, isError: true };
    } else {
      replay = tool.replay;
      try {
        args = validateToolArguments(
          { name: tool.name, description: tool.description, parameters: tool.parameters },
          call,
        ) as Record<string, unknown>;
      } catch (error) {
        result = { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    }
    const transformed = await this.extensions.emit("before_tool_call", { toolName: call.name, args });
    args = transformed.args;
    if (tool && !result && !transformed.denied) {
      try {
        args = validateToolArguments(
          { name: tool.name, description: tool.description, parameters: tool.parameters },
          { ...call, arguments: args },
        ) as Record<string, unknown>;
      } catch (error) {
        result = { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    }
    const resultEntryId = createId("entry");
    const started: Omit<Extract<DurableRecord, { type: "tool_started" }>, "seq" | "timestamp"> = {
      id: createId("record"),
      type: "tool_started",
      lane,
      runId,
      assistantEntryId,
      toolIndex,
      toolCallId: call.id,
      toolName: call.name,
      effectiveArgs: args,
      resultEntryId,
      replay,
    };
    await this.session.appendRecord(started, true);
    safeUiEvent(onUiEvent, { type: "tool_started", id: call.id, name: call.name, args });
    if (!result) {
      if (transformed.denied) {
        result = { content: transformed.denyReason ?? `Tool ${call.name} was denied`, isError: true };
      } else {
        try {
          const ask = this.askPresenter?.();
          result = await tool!.execute(args, {
            rootPath: this.rootPath,
            signal,
            ...(ask ? { ask } : {}),
          });
        } catch (error) {
          /* An abort is the turn ending, not a tool failing: swallowing it into a
           * result would let the loop continue past a cancelled turn. Every other
           * error stays a tool result, so one broken tool cannot end the turn. */
          if (error instanceof Error && error.name === "AbortError") throw error;
          result = { content: error instanceof Error ? error.message : String(error), isError: true };
        }
      }
    }
    let visible: { toolName: string; raw: ToolResult; modelContent: string };
    try {
      visible = await this.extensions.emit("tool_result", {
        toolName: call.name,
        raw: structuredClone(result),
        modelContent: result.content,
      });
    } catch (error) {
      visible = {
        toolName: call.name,
        raw: structuredClone(result),
        modelContent: `${result.content}\n[tool_result extension failed: ${
          error instanceof Error ? error.message : String(error)
        }]`,
      };
    }
    safeUiEvent(onUiEvent, {
      type: "tool_finished",
      id: call.id,
      name: call.name,
      result: structuredClone(result),
      isError: result.isError,
    });
    const message: Message = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: visible.modelContent }],
      details: { raw: result },
      isError: result.isError,
      timestamp: Date.now(),
    };
    return this.session.appendEntry(
      lane,
      { id: resultEntryId, sessionId: this.session.store.sessionId, type: "message", message },
      true,
    );
  }

  private async settle(
    turn: Turn,
    operationId: string,
    outcome: TurnResult["outcome"],
    messages: AssistantMessage[],
    error?: Error,
  ): Promise<TurnResult> {
    const checkpoint = await this.versions.finishTurn(turn, operationId, outcome, error);
    const settled = this.session.projection.turns.get(turn.id)!;
    if (settled.resultCheckpointId !== checkpoint.id) throw new Error("Turn result checkpoint was not persisted");
    await this.extensions.emit("turn_end", { turnId: turn.id, outcome }).catch(() => undefined);
    return { turn: structuredClone(settled), outcome, messages, ...(error ? { error } : {}) };
  }
}
