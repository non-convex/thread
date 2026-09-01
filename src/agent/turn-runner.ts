import { type AssistantMessage, type Context, type Message, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ContextBuilder, BuiltContext } from "../context/builder.js";
import { COMPACTION_TRIGGER_RATIO, contextBudget, type ContextBudget } from "../context/budget.js";
import type { ContextCompactionService, CompactionResult } from "../context/compaction.js";
import type { ExtensionEvents } from "../extensions/events.js";
import type { Turn } from "../session-tree/model.js";
import type { PlannedTurn, SessionTreeService } from "../session-tree/service.js";
import type { ToolRegistry } from "../tools/types.js";
import { safeUiEvent, type UiEventSink } from "../ui/events.js";
import type { ModelClient } from "./model-client.js";
import { SessionTurnJournal } from "./execution-journal.js";
import { AgentStepRunner } from "./step-runner.js";
import type { ToolCallExecutor } from "./tool-call-executor.js";

export interface RunTurnOptions {
  signal: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onUiEvent?: UiEventSink;
}

interface CompactionInvocation {
  reason: "manual" | "threshold" | "overflow";
  turnId: string;
  appendAfter?: Promise<unknown>;
  budget?: ContextBudget;
}

export class TurnRunner {
  private readonly stepRunner: AgentStepRunner;

  constructor(
    private readonly model: ModelClient,
    private readonly tree: SessionTreeService,
    private readonly builder: ContextBuilder,
    private readonly compaction: ContextCompactionService,
    private readonly tools: ToolRegistry,
    toolRunner: ToolCallExecutor,
    private readonly extensions: ExtensionEvents,
    private readonly systemPrompt: string,
    private readonly maxOutputTokens: number,
    reasoning?: ThinkingLevel,
  ) {
    this.stepRunner = new AgentStepRunner(model, toolRunner, maxOutputTokens, reasoning);
  }

  prepareCurrent(): BuiltContext {
    return this.builder.build();
  }

  async execute(
    planned: PlannedTurn,
    turnReady: Promise<Turn>,
    options: RunTurnOptions,
    prepared: BuiltContext,
  ): Promise<AssistantMessage[]> {
    const assistantMessages: AssistantMessage[] = [];
    let overflowRecoveryUsed = false;
    for (let step = 1; ; step++) {
      options.signal.throwIfAborted();
      let assembled = step === 1
        ? await this.assemblePlanned(prepared, planned)
        : await this.assemble(planned.id);
      const budget = this.reportContextUsage(assembled.context, assembled.built.messages, options.onUiEvent);
      // Automatic compaction is inline at a model-step boundary. It appends a
      // checkpoint to this running turn, rebuilds its live context, then starts
      // the same pending step without finishing or replacing the turn.
      if (budget.requestTokens > Math.floor(this.model.contextWindow * COMPACTION_TRIGGER_RATIO) &&
          this.compaction.needsCompaction(assembled.built, budget.overheadTokens, planned.id)) {
        const compacted = await this.compactBuilt(assembled, options, {
          reason: "threshold",
          turnId: planned.id,
          appendAfter: turnReady,
          budget,
        });
        if (compacted.compacted) {
          assembled = await this.assemble(planned.id);
          if (options.onUiEvent) {
            this.reportContextUsage(assembled.context, assembled.built.messages, options.onUiEvent);
          }
        }
      }
      const journal = new SessionTurnJournal(this.tree, planned.id, turnReady);
      const continuedContextMessages = [...assembled.context.messages];
      const continuedSessionMessages = [...assembled.built.messages];
      const result = await this.stepRunner.run(assembled.context, journal, {
        signal: options.signal,
        step,
        ...(options.onTextDelta ? { onTextDelta: options.onTextDelta } : {}),
        ...(options.onUiEvent ? { onUiEvent: options.onUiEvent } : {}),
        onAssistantPersisted: (response) => {
          continuedContextMessages.push(response);
          continuedSessionMessages.push(response);
          if (options.onUiEvent) {
            this.reportContextUsage(
              { ...assembled.context, messages: continuedContextMessages },
              continuedSessionMessages,
              options.onUiEvent,
            );
          }
        },
      });
      const { response, calls, results } = result;
      assistantMessages.push(response);

      if (this.stepRunner.isContextOverflow(response)) {
        if (overflowRecoveryUsed) throw new Error("Context overflow remained after compaction; use /rewind or /new");
        overflowRecoveryUsed = true;
        const overflowContext = await this.assemble(planned.id);
        const recovered = await this.compactBuilt(overflowContext, options, {
          reason: "overflow",
          turnId: planned.id,
          appendAfter: turnReady,
        });
        if (!recovered.compacted) throw new Error("Context overflow cannot be compacted while retaining the newest two turns");
        continue;
      }
      if (response.stopReason === "aborted") throw new DOMException(response.errorMessage ?? "Aborted", "AbortError");
      if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Model request failed");
      if (calls.length === 0) break;
      if (response.stopReason !== "toolUse") {
        throw new Error(`Model returned tool calls with stop reason ${response.stopReason}; calls were not executed`);
      }
      continuedContextMessages.push(...results);
      continuedSessionMessages.push(...results);
      if (options.onUiEvent) {
        this.reportContextUsage(
          { ...assembled.context, messages: continuedContextMessages },
          continuedSessionMessages,
          options.onUiEvent,
        );
      }
    }
    return assistantMessages;
  }

  async compactActive(options: RunTurnOptions): Promise<CompactionResult> {
    this.tree.requireIdle();
    const turnId = this.tree.activeLiveTip;
    if (!turnId) return { compacted: false };
    const built = this.builder.build();
    const context = await this.extendContext(built, `compact_${Date.now()}`);
    return this.compactBuilt({ built, context }, options, { reason: "manual", turnId });
  }

  baseContextFor(messages: Message[]): Context {
    return { systemPrompt: this.systemPrompt, messages, tools: this.tools.modelDefinitions() };
  }

  estimateRequestBudget(messages: Message[]) {
    return contextBudget(this.baseContextFor(messages), messages, this.maxOutputTokens);
  }

  private async assemble(turnId: string): Promise<{ built: BuiltContext; context: Context }> {
    const built = this.builder.build(turnId);
    return { built, context: await this.extendContext(built, turnId) };
  }

  private async assemblePlanned(
    prepared: BuiltContext,
    planned: PlannedTurn,
  ): Promise<{ built: BuiltContext; context: Context }> {
    const userMessage: Message = {
      role: "user",
      content: planned.input,
      timestamp: planned.startedAt,
    };
    const built: BuiltContext = {
      messages: [...prepared.messages, userMessage],
      compactableTurns: [
        ...prepared.compactableTurns,
        { turnId: planned.id, messages: [userMessage] },
      ],
      ...(prepared.latestCompaction ? { latestCompaction: prepared.latestCompaction } : {}),
    };
    return { built, context: await this.extendContext(built, planned.id) };
  }

  private async extendContext(built: BuiltContext, turnId: string): Promise<Context> {
    const initial: Context = {
      systemPrompt: this.systemPrompt,
      messages: built.messages,
      tools: this.tools.modelDefinitions(),
    };
    return (await this.extensions.emit("before_context", { context: initial, turnId })).context;
  }

  private async compactBuilt(
    assembled: { built: BuiltContext; context: Context },
    options: RunTurnOptions,
    invocation: CompactionInvocation,
  ): Promise<CompactionResult> {
    const budget = invocation.budget ?? contextBudget(
      assembled.context,
      assembled.built.messages,
      this.maxOutputTokens,
    );
    if (invocation.reason !== "manual" &&
        !this.compaction.needsCompaction(assembled.built, budget.overheadTokens, invocation.turnId)) {
      return { compacted: false };
    }
    safeUiEvent(options.onUiEvent, { type: "compaction_started", reason: invocation.reason });
    try {
      const result = await this.compaction.compact({
        built: assembled.built,
        context: assembled.context,
        turnId: invocation.turnId,
        reason: invocation.reason,
        signal: options.signal,
        systemTokens: budget.overheadTokens,
        tokensBefore: budget.requestTokens,
        ...(invocation.appendAfter ? { appendAfter: invocation.appendAfter } : {}),
      });
      safeUiEvent(options.onUiEvent, {
        type: "compaction_finished",
        reason: invocation.reason,
        ok: true,
        ...(result.compacted ? { entryId: result.entryId } : {}),
      });
      return result;
    } catch (error) {
      safeUiEvent(options.onUiEvent, { type: "compaction_finished", reason: invocation.reason, ok: false });
      throw error;
    }
  }

  private reportContextUsage(
    context: Context,
    sessionMessages: readonly Message[],
    sink: UiEventSink | undefined,
  ): ContextBudget {
    const budget = contextBudget(context, sessionMessages, this.maxOutputTokens);
    safeUiEvent(sink, {
      type: "context_updated",
      percent: Math.min(999, Math.round((budget.requestTokens / this.model.contextWindow) * 100)),
    });
    return budget;
  }
}
