import { streamModel } from "./model-observation.js";
import { isContextOverflow, type AssistantMessage, type Context, type Message, type ToolCall } from "@earendil-works/pi-ai";
import { executionEventSink, safeExecutionEvent, type ExecutionEventSink } from "../runtime/events.js";
import type { ExecutionJournal } from "./execution-journal.js";
import type { ModelClient } from "./model-client.js";
import { ToolExecutionBatch, type IndexedToolCall } from "./tool-execution-batch.js";
import type { ToolCallExecutor } from "./tool-call-executor.js";
import { messageWithoutImages } from "../session-tree/user-content.js";
import { ToolLoopGuard } from "./tool-loop-guard.js";
import { placeholderAssistant } from "../session-tree/conversation-seal.js";

export interface AgentStepResult {
  response: AssistantMessage;
  calls: IndexedToolCall[];
  results: Message[];
}

export interface AgentStepOptions {
  signal: AbortSignal;
  step: number;
  onExecutionEvent?: ExecutionEventSink;
  onAssistantPersisted?: (response: AssistantMessage) => void | Promise<void>;
}

/** Outer loops share failure semantics; context-overflow recovery remains their own decision. */
export function assertModelStepSucceeded({ response, calls }: AgentStepResult, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (response.stopReason === "aborted") throw new DOMException(response.errorMessage ?? "Aborted", "AbortError");
  if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Model request failed");
  if (calls.length > 0 && response.stopReason !== "toolUse") {
    throw new Error(`Model returned tool calls with stop reason ${response.stopReason}; pending calls were not released`);
  }
}

async function persistBatchResults(journal: ExecutionJournal, results: readonly Message[]): Promise<void> {
  // Results are committed once per attempt. A provider may reuse a call ID in
  // a later attempt, so earlier conversation messages cannot deduplicate them.
  for (const result of results) await journal.appendToolResult(result);
}

function responseCalls(response: AssistantMessage): IndexedToolCall[] {
  return response.content.flatMap((content, contentIndex) =>
    content.type === "toolCall" ? [{ contentIndex, call: content }] : []);
}

/** One model response plus its complete, source-ordered tool execution batch. */
export class AgentStepRunner {
  private readonly loopGuard = new ToolLoopGuard();

  constructor(
    private readonly model: ModelClient,
    private readonly toolRunner: ToolCallExecutor,
    private readonly reasoning?: import("@earendil-works/pi-ai").ThinkingLevel,
  ) {}

  async run(context: Context, journal: ExecutionJournal, options: AgentStepOptions): Promise<AgentStepResult> {
    if (options.step === 1) this.loopGuard.reset();
    if (this.model.acceptsImages !== true) context = { ...context, messages: context.messages.map(messageWithoutImages) };
    this.toolRunner.observeModelContext(context.messages);
    options = { ...options, onExecutionEvent: executionEventSink(journal.identity, options.onExecutionEvent) };
    let assistantEntryId = journal.planAssistantEntryId();
    safeExecutionEvent(options.onExecutionEvent, { type: "assistant_started", step: options.step, entryId: assistantEntryId });
    const createBatch = () => new ToolExecutionBatch({
      journal,
      assistantEntryId,
      signal: options.signal,
      runner: this.toolRunner,
      loopGuard: this.loopGuard,
      ...(options.onExecutionEvent ? { ui: options.onExecutionEvent } : {}),
    });
    let toolBatch = createBatch();
    let response: AssistantMessage | undefined;
    let streamedContent: AssistantMessage["content"] = [];
    const observedCalls = new Map<string, ToolCall>();
    // A rejected durable append may already have updated the projection. Never
    // retry that append with the same ID in the error handler.
    let assistantWriteStarted = false;
    let awaitingRetry = false;
    const appendDelta = (type: "text" | "thinking", delta: string) => {
      const last = streamedContent.at(-1);
      if (type === "text") {
        if (last?.type === "text") last.text += delta;
        else streamedContent.push({ type, text: delta });
      } else {
        if (last?.type === "thinking") last.thinking += delta;
        else streamedContent.push({ type, thinking: delta });
      }
    };
    const persistFailedAttempt = async (cause: unknown): Promise<AgentStepResult> => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const aborted = options.signal.aborted || error.name === "AbortError" || response?.stopReason === "aborted";
      const failed: AssistantMessage = {
        ...(response ?? {
          ...placeholderAssistant({ messages: context.messages, status: aborted ? "interrupted" : "failed", error }),
          provider: this.model.providerId,
          model: this.model.modelId,
          content: structuredClone(streamedContent),
        }),
        stopReason: aborted ? "aborted" : "error",
        errorMessage: error.message,
      };
      // A malformed final response may omit a call already seen in the stream.
      // Retain it in the failed attempt so its durable fact still has an owner.
      const ids = new Set(responseCalls(failed).map(({ call }) => call.id));
      for (const call of observedCalls.values()) {
        if (!ids.has(call.id)) failed.content = [...failed.content, structuredClone(call)];
      }
      const calls = responseCalls(failed);
      const results = await toolBatch.collectSettled(error, [...new Map(calls.map(({ call }) => [call.id, call])).values()]);
      assistantWriteStarted = true;
      await journal.appendAssistant(failed, assistantEntryId);
      await persistBatchResults(journal, results);
      await options.onAssistantPersisted?.(failed);
      return { response: failed, calls, results };
    };
    try {
      response = await streamModel(this.model, context, {
        signal: options.signal,
        maxTokens: this.model.maxOutputTokens,
        ...(this.reasoning ? { reasoning: this.reasoning } : {}),
        onTextDelta: (delta) => {
          awaitingRetry = false;
          appendDelta("text", delta);
          safeExecutionEvent(options.onExecutionEvent, { type: "assistant_text_delta", step: options.step, delta, entryId: assistantEntryId });
        },
        onThinkingDelta: (delta) => {
          awaitingRetry = false;
          appendDelta("thinking", delta);
          safeExecutionEvent(options.onExecutionEvent, { type: "assistant_thinking_delta", step: options.step, delta, entryId: assistantEntryId });
        },
        onToolCallProgress: (progress) => {
          awaitingRetry = false;
          safeExecutionEvent(options.onExecutionEvent, { type: "assistant_tool_call_progress", step: options.step,
            ...progress, entryId: assistantEntryId });
        },
        onToolCallComplete: (call, contentIndex) => {
          awaitingRetry = false;
          if (!observedCalls.has(call.id)) {
            const snapshot = structuredClone(call);
            observedCalls.set(call.id, snapshot);
            streamedContent.push(snapshot);
          }
          return toolBatch.observe(call, contentIndex);
        },
        onAttempt: (event) => {
          // Observation supplies provider metadata when available; deltas and
          // completed calls also cover clients without attempt observations.
          awaitingRetry = false;
          if (event.type === "finished" && event.response) response = event.response;
        },
        onRetryScheduled: async (attempt, maxAttempts, delayMs, errorMessage) => {
          await persistFailedAttempt(new Error(`${errorMessage} (before retry ${attempt})`));
          assistantEntryId = journal.planAssistantEntryId();
          assistantWriteStarted = false;
          response = undefined;
          streamedContent = [];
          observedCalls.clear();
          toolBatch = createBatch();
          awaitingRetry = true;
          safeExecutionEvent(options.onExecutionEvent, {
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
          awaitingRetry = false;
          safeExecutionEvent(options.onExecutionEvent, { type: "model_retry_started", step: options.step, attempt, maxAttempts, entryId: assistantEntryId });
        },
      }, options.onExecutionEvent, { purpose: "agent", entryId: () => assistantEntryId });
      // Pi returns the preceding response as aborted if backoff is cancelled.
      // That attempt is already saved; no new request or tool call took place.
      if (awaitingRetry && options.signal.aborted) throw options.signal.reason;
      const calls = responseCalls(response);
      if (response.stopReason === "aborted" || response.stopReason === "error" ||
          (calls.length > 0 && response.stopReason !== "toolUse")) {
        return await persistFailedAttempt(new Error(response.errorMessage ??
          `Assistant response cannot release tool execution (${response.stopReason})`));
      }
      await toolBatch.reconcile(calls);
      assistantWriteStarted = true;
      await journal.appendAssistant(response, assistantEntryId);
      await options.onAssistantPersisted?.(response);
      if (calls.length === 0) return { response, calls, results: [] };

      toolBatch.releaseResponse();
      let results: Message[];
      try {
        results = await toolBatch.orderedResults();
      } catch (error) {
        results = await toolBatch.collectSettled(error);
      }
      // Persistence failures must escape, not retry a partially committed batch.
      await persistBatchResults(journal, results);
      return { response, calls, results };
    } catch (error) {
      await toolBatch.cancel(error);
      if (!assistantWriteStarted && !awaitingRetry) await persistFailedAttempt(error);
      throw error;
    }
  }

  isContextOverflow(response: AssistantMessage): boolean {
    return response.stopReason === "error" && isContextOverflow(response, this.model.contextWindow);
  }
}
