import {
  type AssistantMessage,
  type Context,
  type Message,
  type ThinkingLevel,
  type ToolCall,
  isContextOverflow,
} from "@earendil-works/pi-ai";
import type { ContextBuilder, BuiltContext } from "../context/builder.js";
import { COMPACTION_TRIGGER_RATIO, contextBudget } from "../context/budget.js";
import type { ContextCompactionService, CompactionResult } from "../context/compaction.js";
import type { ExtensionEvents } from "../extensions/events.js";
import type { Turn } from "../session-tree/model.js";
import type { PlannedTurn, SessionTreeService } from "../session-tree/service.js";
import type { ToolRegistry } from "../tools/types.js";
import { safeUiEvent, type UiEventSink } from "../ui/events.js";
import type { ModelClient } from "./model-client.js";
import type { ToolRunner } from "./tool-runner.js";

export interface RunTurnOptions {
  signal: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onUiEvent?: UiEventSink;
}

export class TurnRunner {
  constructor(
    private readonly model: ModelClient,
    private readonly tree: SessionTreeService,
    private readonly builder: ContextBuilder,
    private readonly compaction: ContextCompactionService,
    private readonly tools: ToolRegistry,
    private readonly toolRunner: ToolRunner,
    private readonly extensions: ExtensionEvents,
    private readonly systemPrompt: string,
    private readonly maxOutputTokens: number,
    private readonly reasoning?: ThinkingLevel,
  ) {}

  prepareCurrent(): Promise<BuiltContext> {
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
      let budget = contextBudget(assembled.context, assembled.built.messages, this.maxOutputTokens);
      if (budget.requestTokens > Math.floor(this.model.contextWindow * COMPACTION_TRIGGER_RATIO) &&
          this.compaction.needsCompaction(assembled.built.turns, assembled.built.compactedThroughTurnId)) {
        const compacted = await this.compactBuilt(assembled, options, "threshold");
        if (compacted.compacted) {
          assembled = step === 1
            ? await this.assemblePlanned(await this.builder.build(), planned)
            : await this.assemble(planned.id);
          budget = contextBudget(assembled.context, assembled.built.messages, this.maxOutputTokens);
        }
      }
      safeUiEvent(options.onUiEvent, { type: "assistant_started", step });
      const response = await this.model.stream(assembled.context, {
        signal: options.signal,
        maxTokens: this.maxOutputTokens,
        ...(this.reasoning ? { reasoning: this.reasoning } : {}),
        onTextDelta: (delta) => {
          options.onTextDelta?.(delta);
          safeUiEvent(options.onUiEvent, { type: "assistant_text_delta", step, delta });
        },
        onThinkingDelta: (delta) => {
          safeUiEvent(options.onUiEvent, { type: "assistant_thinking_delta", step, delta });
        },
        onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
          safeUiEvent(options.onUiEvent, {
            type: "model_retry_scheduled",
            step,
            attempt,
            maxAttempts,
            delayMs,
            errorMessage,
          });
        },
        onRetryAttemptStart: (attempt, maxAttempts) => {
          safeUiEvent(options.onUiEvent, { type: "model_retry_started", step, attempt, maxAttempts });
        },
      });
      assistantMessages.push(response);
      await turnReady;
      const assistantEntry = await this.tree.appendMessage(planned.id, response);
      if (response.stopReason === "error" && isContextOverflow(response, this.model.contextWindow)) {
        if (overflowRecoveryUsed) throw new Error("Context overflow remained after compaction; use /rewind or /new");
        overflowRecoveryUsed = true;
        const overflowContext = await this.assemble(planned.id);
        const recovered = await this.compactBuilt(overflowContext, options, "overflow");
        if (!recovered.compacted) throw new Error("Context overflow cannot be compacted without dropping the retained turn tail");
        continue;
      }
      if (response.stopReason === "aborted") throw new DOMException(response.errorMessage ?? "Aborted", "AbortError");
      if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Model request failed");
      const calls = response.content.filter((content): content is ToolCall => content.type === "toolCall");
      if (calls.length === 0 || response.stopReason !== "toolUse") break;
      for (let index = 0; index < calls.length; index++) {
        await this.toolRunner.run(
          planned.id,
          assistantEntry.id,
          index,
          calls[index]!,
          options.signal,
          options.onUiEvent,
        );
      }
    }
    return assistantMessages;
  }

  async compactActive(options: RunTurnOptions): Promise<CompactionResult> {
    this.tree.requireIdle();
    const built = await this.builder.build();
    const context = await this.extendContext(built, `compact_${Date.now()}`);
    return this.compactBuilt({ built, context }, options, "manual");
  }

  baseContextFor(messages: Message[]): Context {
    return { systemPrompt: this.systemPrompt, messages, tools: this.tools.modelDefinitions() };
  }

  estimateRequestBudget(messages: Message[]) {
    return contextBudget(this.baseContextFor(messages), messages, this.maxOutputTokens);
  }

  private async assemble(turnId: string): Promise<{ built: BuiltContext; context: Context }> {
    const built = await this.builder.build(turnId);
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
      turns: [...prepared.turns, {
        id: planned.id,
        sessionId: planned.sessionId,
        status: "running",
      }],
      ...(prepared.compactedThroughTurnId ? { compactedThroughTurnId: prepared.compactedThroughTurnId } : {}),
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
    reason: "manual" | "threshold" | "overflow",
  ): Promise<CompactionResult> {
    if (reason !== "manual" &&
        !this.compaction.needsCompaction(assembled.built.turns, assembled.built.compactedThroughTurnId)) {
      return { compacted: false };
    }
    safeUiEvent(options.onUiEvent, { type: "compaction_started", reason });
    try {
      const result = await this.compaction.compact({
        turns: assembled.built.turns,
        fullContext: assembled.context,
        signal: options.signal,
      });
      safeUiEvent(options.onUiEvent, { type: "compaction_finished", ok: true });
      return result;
    } catch (error) {
      safeUiEvent(options.onUiEvent, { type: "compaction_finished", ok: false });
      throw error;
    }
  }
}
