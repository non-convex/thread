import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { safeExecutionEvent, type ExecutionEventSink } from "../runtime/events.js";
import { createId } from "../utils/id.js";
import type { ModelClient, ModelRequestOptions } from "./model-client.js";

export type ModelAttemptEvent = { attempt: number; timestamp: number } & (
  | { type: "started" }
  | { type: "finished"; durationMs: number; firstOutputAt?: number; response?: AssistantMessage; error?: string;
      outcome: "completed" | "failed" | "cancelled" }
);

function outcome(signal: AbortSignal, response?: AssistantMessage, error?: unknown): "completed" | "failed" | "cancelled" {
  if (response) return response.stopReason === "aborted" ? "cancelled" : response.stopReason === "error" ? "failed" : "completed";
  if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return "cancelled";
  return error !== undefined ? "failed" : "completed";
}

function emitAttempt(sink: ModelRequestOptions["onAttempt"], event: ModelAttemptEvent): void {
  try {
    const pending = sink?.(structuredClone(event));
    if (pending) void pending.catch(() => undefined);
  } catch { /* Observation only. */ }
}

/** Providers report real attempts here; clients without this hook still expose their logical call. */
export async function observeModelAttempt(
  attempt: number,
  options: ModelRequestOptions,
  invoke: (options: ModelRequestOptions) => Promise<AssistantMessage>,
): Promise<AssistantMessage> {
  if (!options.onAttempt) return invoke(options);
  const start = performance.now();
  let firstOutputAt: number | undefined;
  let response: AssistantMessage | undefined;
  let error: unknown;
  emitAttempt(options.onAttempt, { type: "started", attempt, timestamp: Date.now() });
  try {
    response = await invoke({ ...options,
      onTextDelta: (delta) => { firstOutputAt ??= Date.now(); options.onTextDelta?.(delta); },
      onThinkingDelta: (delta) => { firstOutputAt ??= Date.now(); options.onThinkingDelta?.(delta); },
      onToolCallComplete: (call, index) => { firstOutputAt ??= Date.now(); return options.onToolCallComplete?.(call, index); },
    });
    return response;
  } catch (cause) {
    error = cause;
    throw cause;
  } finally {
    emitAttempt(options.onAttempt, { type: "finished", attempt, timestamp: Date.now(), durationMs: performance.now() - start,
      outcome: outcome(options.signal, response, error),
      ...(firstOutputAt !== undefined ? { firstOutputAt } : {}), ...(response ? { response } : {}),
      ...(error !== undefined ? { error: String(error instanceof Error ? error.message : error) } : {}),
    });
  }
}

export async function streamModel(
  model: ModelClient,
  context: Context,
  options: ModelRequestOptions,
  sink?: ExecutionEventSink,
  detail: { entryId?: () => string; purpose: "agent" | "history_summary" | "progress_summary" } = { purpose: "agent" },
): Promise<AssistantMessage> {
  if (!sink) return model.stream(context, options);
  const capture = sink.captureModelContent?.() ?? false;
  const scope = sink.identity;
  const diagnostics = scope ? sink.promptCacheDiagnostics?.() : undefined;
  let providerPayloadObserved = false;
  const cacheRetention = options.cacheRetention ?? model.cacheRetention;
  const cacheKey = options.sessionId ?? model.cacheKey;
  const common = { callId: createId("model-call"), providerId: model.providerId, modelId: model.modelId, purpose: detail.purpose };
  const identity = () => ({ ...common, ...(detail.entryId ? { entryId: detail.entryId() } : {}) });
  const start = performance.now();
  let firstOutputAt: number | undefined;
  let attemptsObserved = 0;
  let response: AssistantMessage | undefined;
  let error: unknown;
  const resultFields = (value?: AssistantMessage) => value
    ? { usage: value.usage, stopReason: value.stopReason, ...(value.errorMessage ? { error: value.errorMessage } : {}),
        ...(capture ? { response: value } : {}) }
    : {};
  safeExecutionEvent(sink, { type: "model_call_started", ...identity(),
    parameters: {
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
      ...(cacheRetention !== undefined ? { cacheRetention } : {}),
      ...(cacheKey !== undefined ? { cacheKey } : {}),
    }, ...(capture ? { input: context } : {}),
  });
  try {
    response = await model.stream(context, { ...options,
      ...(diagnostics && scope ? { onProviderRequest: (request: { api: string; payload: unknown; attempt: number }) => {
        providerPayloadObserved = true;
        const diagnostic = diagnostics.observe(request.payload, request.api, { ...common, scope, attempt: request.attempt });
        safeExecutionEvent(sink, { type: "model_cache_diagnostic", ...identity(), attempt: request.attempt, diagnostic });
        // The provider supplied a defensive copy. Never return a replacement payload.
        try {
          const pending = options.onProviderRequest?.(request);
          if (pending) void pending.catch(() => undefined);
        } catch { /* Observation only. */ }
      } } : {}),
      onTextDelta: (delta) => { firstOutputAt ??= Date.now(); options.onTextDelta?.(delta); },
      onThinkingDelta: (delta) => { firstOutputAt ??= Date.now(); options.onThinkingDelta?.(delta); },
      onToolCallComplete: (call, index) => { firstOutputAt ??= Date.now(); return options.onToolCallComplete?.(call, index); },
      onAttempt: (event) => {
        emitAttempt(options.onAttempt, event);
        if (event.type === "started") {
          attemptsObserved++;
          safeExecutionEvent(sink, { type: "model_attempt_started", ...identity(), attempt: event.attempt, timestamp: event.timestamp });
        } else {
          const { type: _, response: value, ...timing } = event;
          safeExecutionEvent(sink, { type: "model_attempt_finished", ...identity(), ...timing, ...resultFields(value) });
        }
      },
    });
    return response;
  } catch (cause) {
    error = cause;
    throw cause;
  } finally {
    if (diagnostics && !providerPayloadObserved) {
      safeExecutionEvent(sink, { type: "model_cache_diagnostic", ...identity(), diagnostic: {
        stage: "provider_payload", status: "unavailable", reason: "provider_payload_not_observed",
      } });
    }
    safeExecutionEvent(sink, { type: "model_call_finished", ...identity(), durationMs: performance.now() - start,
      outcome: outcome(options.signal, response, error), attemptsObserved, ...resultFields(response),
      ...(firstOutputAt !== undefined ? { firstOutputAt } : {}),
      ...(error !== undefined ? { error: String(error instanceof Error ? error.message : error) } : {}),
    });
  }
}
