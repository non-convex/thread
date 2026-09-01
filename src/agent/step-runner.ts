import { isContextOverflow, type AssistantMessage, type Context, type Message } from "@earendil-works/pi-ai";
import { safeUiEvent, type UiEventSink } from "../ui/events.js";
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
  onUiEvent?: UiEventSink;
  onAssistantPersisted?: (response: AssistantMessage) => void | Promise<void>;
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
    safeUiEvent(options.onUiEvent, { type: "assistant_started", step: options.step });
    let assistantEntryId = journal.planAssistantEntryId();
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
          options.onTextDelta?.(delta);
          safeUiEvent(options.onUiEvent, { type: "assistant_text_delta", step: options.step, delta });
        },
        onThinkingDelta: (delta) => {
          safeUiEvent(options.onUiEvent, { type: "assistant_thinking_delta", step: options.step, delta });
        },
        onToolCallComplete: (call, contentIndex) => toolBatch.observe(call, contentIndex),
        onRetryScheduled: async (attempt, maxAttempts, delayMs, errorMessage) => {
          const nextEntryId = journal.planAssistantEntryId();
          await toolBatch.restartForModelRetry(new Error(`Model attempt failed before retry ${attempt}`), nextEntryId);
          assistantEntryId = nextEntryId;
          safeUiEvent(options.onUiEvent, {
            type: "model_retry_scheduled",
            step: options.step,
            attempt,
            maxAttempts,
            delayMs,
            errorMessage,
          });
        },
        onRetryAttemptStart: (attempt, maxAttempts) => {
          safeUiEvent(options.onUiEvent, { type: "model_retry_started", step: options.step, attempt, maxAttempts });
        },
      });
      const calls: IndexedToolCall[] = response.content.flatMap((content, contentIndex) =>
        content.type === "toolCall" ? [{ contentIndex, call: content }] : []
      );
      await toolBatch.reconcile(calls);
      await journal.ready;
      await journal.appendAssistant(response, assistantEntryId);
      await options.onAssistantPersisted?.(response);

      if (response.stopReason === "aborted" || response.stopReason === "error" ||
          (calls.length > 0 && response.stopReason !== "toolUse")) {
        await toolBatch.cancel(new Error("Assistant response cannot release tool execution"));
        return { response, calls, results: [] };
      }
      if (calls.length === 0) return { response, calls, results: [] };

      toolBatch.releaseResponse();
      const results = await toolBatch.orderedResults();
      for (const result of results) await journal.appendToolResult(result);
      return { response, calls, results };
    } catch (error) {
      await toolBatch.cancel(error);
      throw error;
    }
  }

  isContextOverflow(response: AssistantMessage): boolean {
    return response.stopReason === "error" && isContextOverflow(response, this.model.contextWindow);
  }
}
