import type { Context, AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExecutionIdentity } from "./policy.js";
import type { AgentTaskSummary } from "../agent-task/model.js";
import type { PromptCacheDiagnostic, PromptCacheDiagnostics } from "../agent/prompt-cache-diagnostics.js";

export type ModelEvent = {
  callId: string;
  entryId?: string;
  providerId: string;
  modelId: string;
  purpose: "agent" | "history_summary" | "progress_summary";
} & (
  | { type: "model_call_started"; input?: Context; parameters: { maxTokens?: number; reasoning?: string; cacheRetention?: string; cacheKey?: string } }
  | { type: "model_call_finished"; outcome: "completed" | "failed" | "cancelled"; durationMs: number;
      firstOutputAt?: number; response?: AssistantMessage; usage?: Usage; stopReason?: string; error?: string; attemptsObserved: number }
  | { type: "model_cache_diagnostic"; attempt?: number; diagnostic: PromptCacheDiagnostic }
  | { type: "model_attempt_started"; attempt: number }
  | { type: "model_attempt_finished"; attempt: number; outcome: "completed" | "failed" | "cancelled";
      durationMs: number; firstOutputAt?: number; response?: AssistantMessage; usage?: Usage; stopReason?: string; error?: string }
);

type ToolEvent =
  | { type: "tool_started"; id: string; name: string; args: Record<string, unknown>; assistantEntryId: string; phase: "queued" | "running" }
  | { type: "tool_finished"; id: string; name: string; assistantEntryId: string; outcome: "completed" | "failed" | "cancelled" | "denied";
      isError: boolean; error?: string; content?: string; durationMs?: number; details?: unknown };

type AgentEvent = ModelEvent | ToolEvent
  | { type: "assistant_started"; step: number; entryId?: string }
  | { type: "assistant_text_delta"; step: number; delta: string; entryId?: string }
  | { type: "assistant_thinking_delta"; step: number; delta: string; entryId?: string }
  | { type: "assistant_tool_call_progress"; step: number; id: string; name: string; argumentBytes: number; entryId?: string }
  | { type: "agent_run_started"; input: string; entryId?: string }
  | { type: "agent_run_finished"; outcome: "completed" | "failed" | "cancelled"; output: string; error?: string };

type ExecutionPayload = (
  | AgentEvent
  | { type: "agent_task_created"; summary: AgentTaskSummary }
  | { type: "agent_task_updated"; summary: AgentTaskSummary }
  | {
      type: "session_changed";
      sessionId: string;
      liveTipTurnId: string | null;
      reason: "turn" | "new" | "opened" | "rewind";
    }
  | { type: "turn_preparing"; input: string; sessionId: string }
  | {
      type: "turn_started";
      turnId: string;
      userEntryId?: string;
      input: string;
      sessionId: string;
    }
  | {
      type: "model_retry_scheduled";
      step: number;
      entryId?: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "model_retry_started"; step: number; attempt: number; maxAttempts: number; entryId?: string }
  | { type: "context_updated"; percent: number; estimatedTokens?: number; contextWindow?: number }
  | { type: "compaction_started"; reason: "threshold" | "overflow" | "manual" }
  | { type: "compaction_finished"; reason: "threshold" | "overflow" | "manual"; ok: false }
  | {
      type: "compaction_finished";
      reason: "threshold" | "overflow" | "manual";
      ok: true;
      entryId?: string;
      summarizedSteps?: number;
      retainedSteps?: number;
      tokensSaved?: number;
    }
  | {
      type: "turn_finished";
      output: string;
      outcome: "completed" | "interrupted" | "failed";
      error?: string;
      limit?: import("./limits.js").RuntimeLimit;
    });

export type ExecutionEvent = ExecutionPayload & { timestamp?: number; identity?: ExecutionIdentity };
export type ExecutionEventSink = ((event: ExecutionEvent) => void) & {
  captureModelContent?: () => boolean;
  promptCacheDiagnostics?: () => PromptCacheDiagnostics | undefined;
  identity?: ExecutionIdentity;
};

export type RuntimeScope = ExecutionIdentity;
type AssistantEvent = Extract<ExecutionPayload, { type: "assistant_started" | "assistant_text_delta" | "assistant_thinking_delta" | "assistant_tool_call_progress" | "model_retry_scheduled" | "model_retry_started" }>;
type OtherEvent = Exclude<ExecutionPayload, AssistantEvent | ToolEvent | { type: "context_updated" }>;

/** Live facts, not a durable replay log. Workers use the same event shapes as the main agent. */
export type RuntimeEvent = RuntimeScope & { timestamp: number } & (
  | OtherEvent
  | (AssistantEvent & { entryId: string })
  | (ToolEvent & { toolCallId: string })
  | { type: "context_updated"; estimatedTokens: number; contextWindow: number }
);
export type RuntimeEventSink = (event: RuntimeEvent) => void | Promise<void>;
export interface RuntimeSubscriptionOptions {
  /** Includes model inputs and complete responses. Tool content and text deltas are already public events. */
  captureModelContent?: boolean;
  /** Compare provider-formatted request prefixes without publishing their contents. Default: false. */
  promptCacheDiagnostics?: boolean;
}

export function safeRuntimeEvent(sink: RuntimeEventSink | undefined, event: RuntimeEvent): void {
  if (!sink) return;
  try {
    const pending = sink(structuredClone(event));
    if (pending) void pending.catch(() => undefined);
  } catch { /* Observers cannot change execution semantics. */ }
}

export function safeExecutionEvent(sink: ExecutionEventSink | undefined, event: ExecutionEvent): void {
  if (!sink) return;
  const timestamp = event.timestamp ?? Date.now();
  try { sink({ ...structuredClone(event), timestamp }); } catch { /* Observation only. */ }
}

export function executionEventSink(identity: ExecutionIdentity, sink?: ExecutionEventSink): ExecutionEventSink {
  return Object.assign((event: ExecutionEvent) => safeExecutionEvent(sink, { ...event, identity: event.identity ?? identity }),
    { identity, captureModelContent: () => sink?.captureModelContent?.() ?? false,
      promptCacheDiagnostics: () => sink?.promptCacheDiagnostics?.() });
}

export function runtimeEventSink(
  scope: RuntimeScope,
  sink?: RuntimeEventSink,
  captureModelContent?: () => boolean,
  promptCacheDiagnostics?: () => PromptCacheDiagnostics | undefined,
): ExecutionEventSink {
  const emit: ExecutionEventSink = (event) => {
    if (!sink) return;
    const { identity, ...payload } = event;
    const common = { ...scope, ...identity, timestamp: event.timestamp ?? Date.now() };
    switch (payload.type) {
      case "assistant_started":
      case "assistant_text_delta":
      case "assistant_thinking_delta":
      case "assistant_tool_call_progress":
      case "model_retry_scheduled":
      case "model_retry_started":
        if (payload.entryId) safeRuntimeEvent(sink, { ...payload, ...common, entryId: payload.entryId });
        return;
      case "tool_started":
      case "tool_finished":
        safeRuntimeEvent(sink, { ...payload, ...common, toolCallId: payload.id });
        return;
      case "context_updated":
        if (payload.estimatedTokens !== undefined && payload.contextWindow !== undefined) {
          safeRuntimeEvent(sink, { ...common, type: "context_updated", estimatedTokens: payload.estimatedTokens, contextWindow: payload.contextWindow });
        }
        return;
      default:
        safeRuntimeEvent(sink, { ...common, ...payload });
    }
  };
  emit.identity = scope;
  emit.captureModelContent = captureModelContent ?? (() => false);
  if (promptCacheDiagnostics) emit.promptCacheDiagnostics = promptCacheDiagnostics;
  return emit;
}

export function withoutModelContent(event: RuntimeEvent): RuntimeEvent {
  if (event.type === "model_call_started") {
    const { input: _, ...metadata } = event;
    return metadata;
  }
  if (event.type === "model_call_finished" || event.type === "model_attempt_finished") {
    const { response: _, ...metadata } = event;
    return metadata;
  }
  return event;
}
