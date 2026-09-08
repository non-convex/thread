import { type AssistantMessage, type Context, type ImageContent, type Message, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ContextBuilder, BuiltContext } from "../context/builder.js";
import { COMPACTION_TRIGGER_RATIO, contextBudget, type ContextBudget } from "../context/budget.js";
import {
  type ContextCompactionService,
  type CompactionResult,
} from "../context/compaction/index.js";
import type { ExtensionEvents } from "../extensions/events.js";
import type { Turn } from "../session-tree/model.js";
import type { SessionTreeService } from "../session-tree/service.js";
import type { ToolRegistry } from "../tools/types.js";
import { safeExecutionEvent, type ExecutionEventSink } from "../runtime/events.js";
import { messageWithoutImages } from "../session-tree/user-content.js";
import type { RuntimeEventSink } from "../runtime/events.js";
import { RuntimeLimitError, type ExecutionLimits } from "../runtime/limits.js";
import type { ModelClient } from "./model-client.js";
import { SessionTurnJournal } from "./execution-journal.js";
import { AgentStepRunner } from "./step-runner.js";
import type { ToolCallExecutor } from "./tool-call-executor.js";

export interface RunTurnOptions extends ExecutionLimits {
  signal: AbortSignal;
  sessionId?: string;
  onEvent?: RuntimeEventSink;
  onTextDelta?: (delta: string) => void;
  onUiEvent?: ExecutionEventSink;
  images?: readonly ImageContent[];
}

interface CompactionInvocation {
  reason: "manual" | "threshold" | "overflow";
  turnId: string;
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
    maxOutputTokens: number,
    reasoning?: ThinkingLevel,
  ) {
    this.stepRunner = new AgentStepRunner(model, toolRunner, maxOutputTokens, reasoning);
  }

  async execute(turn: Turn, options: RunTurnOptions): Promise<AssistantMessage[]> {
    const assistantMessages: AssistantMessage[] = [];
    let overflowRecoveryUsed = false;
    for (let step = 1; ; step++) {
      options.signal.throwIfAborted();
      if (options.maxSteps !== undefined && step > options.maxSteps) {
        throw new RuntimeLimitError("maxSteps", options.maxSteps);
      }
      let assembled = await this.assemble(turn.id);
      const budget = this.reportContextUsage(assembled.context, assembled.built.messages, options.onUiEvent);
      const threshold = Math.floor(this.model.contextWindow * COMPACTION_TRIGGER_RATIO);
      if (budget.requestTokens > threshold &&
          this.compaction.needsCompaction(assembled.built, budget.overheadTokens, turn.id)) {
        const compacted = await this.compactBuilt(assembled, options, {
          reason: "threshold",
          turnId: turn.id,
          budget,
        });
        if (compacted.compacted) {
          assembled = await this.assemble(turn.id);
          this.reportContextUsage(assembled.context, assembled.built.messages, options.onUiEvent);
        }
      }
      const journal = new SessionTurnJournal(this.tree, turn.id, turn.sessionId);
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
        let overflowContext = await this.assemble(turn.id);
        const overflowBudget = this.reportContextUsage(
          overflowContext.context,
          overflowContext.built.messages,
          options.onUiEvent,
        );
        if (!this.compaction.needsCompaction(
          overflowContext.built,
          overflowBudget.overheadTokens,
          turn.id,
        )) {
          throw new Error("Context overflow cannot be reduced by compaction; use /rewind or /new");
        }
        const recovered = await this.compactBuilt(overflowContext, options, {
          reason: "overflow",
          turnId: turn.id,
          budget: overflowBudget,
        });
        if (!recovered.compacted) {
          throw new Error("Context overflow cannot be reduced by compaction; use /rewind or /new");
        }
        overflowContext = await this.assemble(turn.id);
        const recoveredBudget = this.reportContextUsage(
          overflowContext.context,
          overflowContext.built.messages,
          options.onUiEvent,
        );
        if (recoveredBudget.requestTokens >= this.model.contextWindow) {
          throw new Error("Context remains above the model window after compaction; use /rewind or /new");
        }
        continue;
      }
      if (response.stopReason === "aborted" || options.signal.aborted) {
        throw new DOMException(response.errorMessage ?? "Aborted", "AbortError");
      }
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
    const turnId = options.sessionId
      ? this.tree.projection.liveTips.get(options.sessionId)
      : this.tree.activeLiveTip;
    if (!turnId) return { compacted: false };
    const built = this.builder.build(undefined, options.sessionId);
    const context = await this.extendContext(built, `compact_${Date.now()}`);
    return this.compactBuilt({ built, context }, options, { reason: "manual", turnId });
  }

  private async assemble(turnId: string): Promise<{ built: BuiltContext; context: Context }> {
    const built = this.builder.build(turnId);
    return { built, context: await this.extendContext(built, turnId) };
  }

  private async extendContext(built: BuiltContext, turnId: string): Promise<Context> {
    const initial: Context = {
      systemPrompt: this.systemPrompt,
      messages: this.messagesForModel(built.messages),
      tools: this.tools.modelDefinitions(),
    };
    return (await this.extensions.emit("before_context", { context: initial, turnId })).context;
  }

  private messagesForModel(messages: Message[]): Message[] {
    if (this.model.acceptsImages === true) return messages;
    return messages.map(messageWithoutImages);
  }

  private async compactBuilt(
    assembled: { built: BuiltContext; context: Context },
    options: RunTurnOptions,
    invocation: CompactionInvocation,
  ): Promise<CompactionResult> {
    const budget = invocation.budget ?? contextBudget(
      assembled.context,
      assembled.built.messages,
    );
    if (invocation.reason !== "manual" &&
        !this.compaction.needsCompaction(assembled.built, budget.overheadTokens, invocation.turnId)) {
      return { compacted: false };
    }
    safeExecutionEvent(options.onUiEvent, { type: "compaction_started", reason: invocation.reason });
    try {
      const result = await this.compaction.compact({
        built: assembled.built,
        context: assembled.context,
        turnId: invocation.turnId,
        reason: invocation.reason,
        signal: options.signal,
        systemTokens: budget.overheadTokens,
        tokensBefore: budget.requestTokens,
      });
      safeExecutionEvent(options.onUiEvent, {
        type: "compaction_finished",
        reason: invocation.reason,
        ok: true,
        ...(result.compacted
          ? {
              entryId: result.entryId,
              summarizedSteps: result.summarizedSteps,
              retainedSteps: result.retainedSteps,
              tokensSaved: result.tokensBefore - result.tokensAfter,
            }
          : {}),
      });
      return result;
    } catch (error) {
      safeExecutionEvent(options.onUiEvent, { type: "compaction_finished", reason: invocation.reason, ok: false });
      throw error;
    }
  }

  private reportContextUsage(
    context: Context,
    sessionMessages: readonly Message[],
    sink: ExecutionEventSink | undefined,
  ): ContextBudget {
    const budget = contextBudget(context, sessionMessages);
    safeExecutionEvent(sink, {
      type: "context_updated",
      percent: Math.min(999, Math.round((budget.requestTokens / this.model.contextWindow) * 100)),
      estimatedTokens: budget.requestTokens,
      contextWindow: this.model.contextWindow,
    });
    return budget;
  }
}
