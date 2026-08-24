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
import type { SessionService } from "../session/service.js";
import type { AgentTool, ToolRegistry, ToolResult } from "../tools/types.js";
import { safeUiEvent, type UiEventSink } from "../ui/events.js";
import { createId } from "../utils/id.js";
import { estimateContextTokens } from "../utils/estimate.js";
import { ContextCompactor } from "./compaction.js";
import type { ModelClient } from "./model-client.js";

const DEFAULT_SYSTEM_PROMPT = `You are thread, a coding agent working in a long-lived project session. Use the provided tools to inspect and modify the workspace. Keep changes scoped to the user's request and verify important edits. When answering or reporting results, lower the information density without omitting useful information. Add context when helpful, use natural transitions, and explain complex ideas clearly and at a measured pace.`;

export interface AgentLoopOptions {
  systemPrompt?: string;
  maxSteps?: number;
  maxOutputTokens?: number;
  reasoning?: ThinkingLevel;
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
  private readonly maxSteps: number;
  private readonly maxOutputTokens: number;
  private readonly reasoning: ThinkingLevel | undefined;
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
    this.maxSteps = options.maxSteps ?? 24;
    this.maxOutputTokens =
      options.maxOutputTokens ??
      Math.min(model.maxOutputTokens, 16_384, Math.max(1_024, Math.floor(model.contextWindow * 0.2)));
    this.reasoning = options.reasoning;
    this.compactor = new ContextCompactor(session, model, {
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    });
  }

  async compactCurrent(options: RunTurnOptions): Promise<ManualCompactionResult> {
    this.versions.requireIdle();
    const branchName = this.versions.currentBranch.name;
    const head = this.session.projection.lanes.get(branchName) ?? null;
    const messages = this.session.buildContext(head).messages;
    const manualContext: Context = {
      systemPrompt: this.systemPrompt,
      messages,
      tools: this.tools.modelDefinitions(),
    };
    const budget = this.estimateCompactionBudget(manualContext, messages);
    const retainedTailBudget = this.compactor.retainedTailBudget(budget.overheadTokens);
    if (!this.compactor.canCompact(messages, retainedTailBudget)) return { compacted: false };

    const operationId = createId("operation");
    const resultEntryId = createId("entry");
    await this.session.appendRecord(
      {
        id: operationId,
        type: "operation_started",
        lane: branchName,
        sourceLeafId: head,
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
      const run = await this.compactor.compact(
        branchName,
        messages,
        budget.requestTokens,
        retainedTailBudget,
        options.signal,
        { runId: operationId, resultEntryId },
        "manual",
        observer,
      );
      if (!run) throw new Error("Context became ineligible for compaction");
      const checkpoint = await this.versions.finishCompaction(operationId, branchName);
      return {
        compacted: true,
        checkpointId: checkpoint.id,
        summarizedMessages: run.summarizedMessages,
        retainedMessages: run.retainedMessages,
        modelCalls: run.modelCalls,
      };
    } catch (error) {
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

    const assistantMessages: AssistantMessage[] = [];
    let outcome: TurnResult["outcome"] = "completed";
    let failure: Error | undefined;
    let completed = false;
    try {
      await this.extensions.emit("turn_start", { turnId, branch: branchName, input });
      for (let step = 0; step < this.maxSteps; step++) {
        runSignal.throwIfAborted();
        const compactionObserver = {
          started: (reason: "manual" | "threshold" | "overflow") =>
            safeUiEvent(options.onUiEvent, { type: "compaction_started", reason }),
          finished: (ok: boolean) => safeUiEvent(options.onUiEvent, { type: "compaction_finished", ok }),
        };
        let assembled = await this.assembleContext(branchName, turnId);
        let budget = this.estimateCompactionBudget(assembled.context, assembled.sessionMessages);
        const compacted = await this.compactor.compactIfNeeded(
          branchName,
          assembled.sessionMessages,
          budget,
          runSignal,
          { runId: operationId },
          compactionObserver,
        );
        if (compacted) {
          assembled = await this.assembleContext(branchName, turnId);
          budget = this.estimateCompactionBudget(assembled.context, assembled.sessionMessages);
        }
        const context = assembled.context;
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
        const [response] = await Promise.all([this.model.stream(context, {
          signal: runSignal,
          maxTokens: this.maxOutputTokens,
          ...(this.reasoning ? { reasoning: this.reasoning } : {}),
          sessionId: this.session.store.sessionId,
          onTextDelta: (delta) => {
            options.onTextDelta?.(delta);
            safeUiEvent(options.onUiEvent, { type: "assistant_text_delta", step: step + 1, delta });
          },
          onThinkingDelta: (delta) => {
            safeUiEvent(options.onUiEvent, { type: "assistant_thinking_delta", step: step + 1, delta });
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
          const current = this.session.buildContext(this.session.projection.lanes.get(branchName) ?? null).messages;
          await this.compactor.compact(
            branchName,
            current,
            budget.requestTokens,
            this.compactor.retainedTailBudget(budget.overheadTokens),
            runSignal,
            { runId: operationId },
            "overflow",
            compactionObserver,
          );
          continue;
        }
        if (response.stopReason === "aborted") throw new DOMException(response.errorMessage ?? "Aborted", "AbortError");
        if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Model request failed");
        const calls = response.content.filter((content): content is ToolCall => content.type === "toolCall");
        if (calls.length === 0 || response.stopReason !== "toolUse") {
          completed = true;
          break;
        }
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
      if (!completed) throw new Error(`Agent exceeded maximum step count (${this.maxSteps})`);
    } catch (error) {
      failure = preparationFailure ?? (error instanceof Error ? error : new Error(String(error)));
      outcome = options.signal.aborted || failure.name === "AbortError" ? "aborted" : "failed";
    }
    try {
      await turnReady;
    } catch (error) {
      const cause = preparationFailure ?? (error instanceof Error ? error : new Error(String(error)));
      await this.abandonUnstartedTurn(branchName, operationId, base.sessionHeadId, cause, options.signal.aborted);
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
  ): Promise<{ context: Context; sessionMessages: Message[] }> {
    const built = this.session.buildContext(this.session.projection.lanes.get(branchName) ?? null);
    let context: Context = {
      systemPrompt: this.systemPrompt,
      messages: built.messages,
      tools: this.tools.modelDefinitions(),
    };
    context = (await this.extensions.emit("before_context", { context, turnId })).context;
    return { context, sessionMessages: built.messages };
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
          result = await tool!.execute(args, { rootPath: this.rootPath, signal });
        } catch (error) {
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
