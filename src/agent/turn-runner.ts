import {
  type AssistantMessage,
  type Context,
  type Message,
  type ThinkingLevel,
  isContextOverflow,
} from "@earendil-works/pi-ai";
import type { ContextBuilder, BuiltContext } from "../context/builder.js";
import { COMPACTION_TRIGGER_RATIO, contextBudget, type ContextBudget } from "../context/budget.js";
import type { ContextCompactionService, CompactionResult } from "../context/compaction.js";
import type { ExtensionEvents } from "../extensions/events.js";
import type { Turn } from "../session-tree/model.js";
import type { PlannedTurn, SessionTreeService } from "../session-tree/service.js";
import type { ToolRegistry } from "../tools/types.js";
import { safeUiEvent, type UiEventSink } from "../ui/events.js";
import type { ModelClient } from "./model-client.js";
import { ToolExecutionBatch, type IndexedToolCall } from "./tool-execution-batch.js";
import type { ToolRunner } from "./tool-runner.js";

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
      const budget = contextBudget(assembled.context, assembled.built.messages, this.maxOutputTokens);
      if (budget.requestTokens > Math.floor(this.model.contextWindow * COMPACTION_TRIGGER_RATIO) &&
          this.compaction.needsCompaction(assembled.built, budget.overheadTokens)) {
        const compacted = await this.compactBuilt(assembled, options, {
          reason: "threshold",
          turnId: planned.id,
          appendAfter: turnReady,
          budget,
        });
        if (compacted.compacted) {
          assembled = await this.assemble(planned.id);
        }
      }
      safeUiEvent(options.onUiEvent, { type: "assistant_started", step });
      let assistantEntry = this.tree.planMessageEntry(planned.id);
      const toolBatch = new ToolExecutionBatch({
        turnId: planned.id,
        assistantEntryId: assistantEntry.id,
        signal: options.signal,
        turnReady,
        runner: this.toolRunner,
        ...(options.onUiEvent ? { ui: options.onUiEvent } : {}),
      });
      try {
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
          onToolCallComplete: (call, contentIndex) => toolBatch.observe(call, contentIndex),
          onRetryScheduled: async (attempt, maxAttempts, delayMs, errorMessage) => {
            const nextAssistantEntry = this.tree.planMessageEntry(planned.id);
            await toolBatch.restartForModelRetry(
              new Error(`Model attempt failed before retry ${attempt}`),
              nextAssistantEntry.id,
            );
            assistantEntry = nextAssistantEntry;
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
        const calls: IndexedToolCall[] = response.content.flatMap((content, contentIndex) =>
          content.type === "toolCall" ? [{ contentIndex, call: content }] : []
        );
        await toolBatch.reconcile(calls);
        await turnReady;
        // The full assistant message is the release barrier for mutations and
        // interactive/process tools. Read effects may already be in flight.
        await this.tree.appendMessage({ turnId: planned.id, message: response, entryId: assistantEntry.id }, true);

        if (response.stopReason === "error" && isContextOverflow(response, this.model.contextWindow)) {
          await toolBatch.cancel(new Error("Context-overflow response cannot continue tool execution"));
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
        if (response.stopReason === "aborted") {
          throw new DOMException(response.errorMessage ?? "Aborted", "AbortError");
        }
        if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Model request failed");
        if (calls.length === 0) break;
        if (response.stopReason !== "toolUse") {
          throw new Error(`Model returned tool calls with stop reason ${response.stopReason}; calls were not executed`);
        }

        toolBatch.releaseResponse();
        const results = await toolBatch.orderedResults();
        for (const result of results) {
          await this.tree.appendMessage({ turnId: planned.id, message: result });
        }
      } catch (error) {
        await toolBatch.cancel(error);
        throw error;
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
        !this.compaction.needsCompaction(assembled.built, budget.overheadTokens)) {
      return { compacted: false };
    }
    safeUiEvent(options.onUiEvent, { type: "compaction_started", reason: invocation.reason });
    try {
      const result = await this.compaction.compact({
        built: assembled.built,
        turnId: invocation.turnId,
        reason: invocation.reason,
        signal: options.signal,
        systemTokens: budget.overheadTokens,
        tokensBefore: budget.requestTokens,
        ...(invocation.appendAfter ? { appendAfter: invocation.appendAfter } : {}),
      });
      safeUiEvent(options.onUiEvent, { type: "compaction_finished", ok: true });
      return result;
    } catch (error) {
      safeUiEvent(options.onUiEvent, { type: "compaction_finished", ok: false });
      throw error;
    }
  }
}
