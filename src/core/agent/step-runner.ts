import { isContextOverflow, type AssistantMessage, type Context, type Message } from "@earendil-works/pi-ai";
import { safeExecutionEvent, type ExecutionEventSink } from "../runtime/events.js";
import type { ExecutionJournal } from "./execution-journal.js";
import type { ModelClient } from "./model-client.js";
import { ToolExecutionBatch, type IndexedToolCall } from "./tool-execution-batch.js";
import type { ToolCallExecutor } from "./tool-call-executor.js";

export interface AgentStepResult {
  response: AssistantMessage;
  calls: IndexedToolCall[];
  results: Message[];
}

export interface AgentStepOptions {
  signal: AbortSignal;
  step: number;
  onTextDelta?: (delta: string) => void;
  onUiEvent?: ExecutionEventSink;
  onAssistantPersisted?: (response: AssistantMessage) => void | Promise<void>;
}

async function persistBatchResults(
  journal: ExecutionJournal,
  collect: () => Promise<Message[]>,
): Promise<Message[]> {
  const results = await collect();
  const existing = new Set(
    journal.conversationMessages()
      .filter((message) => message.role === "toolResult")
      .map((message) => message.toolCallId),
  );
  for (const result of results) {
    if (result.role !== "toolResult" || existing.has(result.toolCallId)) continue;
    await journal.appendToolResult(result);
    existing.add(result.toolCallId);
  }
  return results;
}

/** One model response plus its complete, source-ordered tool execution batch. */
export class AgentStepRunner {
  constructor(
    private readonly model: ModelClient,
    private readonly toolRunner: ToolCallExecutor,
    private readonly maxOutputTokens: number,
    private readonly reasoning?: import("@earendil-works/pi-ai").ThinkingLevel,
  ) {}

  async run(context: Context, journal: ExecutionJournal, options: AgentStepOptions): Promise<AgentStepResult> {
    let assistantEntryId = journal.planAssistantEntryId();
    safeExecutionEvent(options.onUiEvent, { type: "assistant_started", step: options.step, entryId: assistantEntryId });
    const toolBatch = new ToolExecutionBatch({
      journal,
      assistantEntryId,
      signal: options.signal,
      runner: this.toolRunner,
      ...(options.onUiEvent ? { ui: options.onUiEvent } : {}),
    });
    try {
      const response = await this.model.stream(context, {
        signal: options.signal,
        maxTokens: this.maxOutputTokens,
        ...(this.reasoning ? { reasoning: this.reasoning } : {}),
        onTextDelta: (delta) => {
          try { options.onTextDelta?.(delta); } catch { /* A legacy text observer cannot cancel the turn. */ }
          safeExecutionEvent(options.onUiEvent, { type: "assistant_text_delta", step: options.step, delta, entryId: assistantEntryId });
        },
        onThinkingDelta: (delta) => {
          safeExecutionEvent(options.onUiEvent, { type: "assistant_thinking_delta", step: options.step, delta, entryId: assistantEntryId });
        },
        onToolCallComplete: (call, contentIndex) => toolBatch.observe(call, contentIndex),
        onRetryScheduled: async (attempt, maxAttempts, delayMs, errorMessage) => {
          const nextEntryId = journal.planAssistantEntryId();
          await toolBatch.restartForModelRetry(new Error(`Model attempt failed before retry ${attempt}`), nextEntryId);
          assistantEntryId = nextEntryId;
          safeExecutionEvent(options.onUiEvent, {
            type: "model_retry_scheduled",
            step: options.step,
            entryId: assistantEntryId,
            attempt,
            maxAttempts,
            delayMs,
            errorMessage,
          });
        },
        onRetryAttemptStart: (attempt, maxAttempts) => {
          safeExecutionEvent(options.onUiEvent, { type: "model_retry_started", step: options.step, attempt, maxAttempts, entryId: assistantEntryId });
        },
      });
      const calls: IndexedToolCall[] = response.content.flatMap((content, contentIndex) =>
        content.type === "toolCall" ? [{ contentIndex, call: content }] : []
      );
      await toolBatch.reconcile(calls);
      await journal.appendAssistant(response, assistantEntryId);
      await options.onAssistantPersisted?.(response);

      if (response.stopReason === "aborted" || response.stopReason === "error" ||
          (calls.length > 0 && response.stopReason !== "toolUse")) {
        const results = await persistBatchResults(journal, () =>
          toolBatch.collectSettled(new Error("Assistant response cannot release tool execution")),
        );
        return { response, calls, results };
      }
      if (calls.length === 0) return { response, calls, results: [] };

      toolBatch.releaseResponse();
      try {
        const results = await persistBatchResults(journal, () => toolBatch.orderedResults());
        return { response, calls, results };
      } catch (error) {
        const results = await persistBatchResults(journal, () => toolBatch.collectSettled(error));
        return { response, calls, results };
      }
    } catch (error) {
      await toolBatch.cancel(error);
      throw error;
    }
  }

  isContextOverflow(response: AssistantMessage): boolean {
    return response.stopReason === "error" && isContextOverflow(response, this.model.contextWindow);
  }
}
