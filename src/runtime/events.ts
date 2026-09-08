import type { AgentTaskSummary } from "../agent-task/model.js";

export type AgentTaskLiveEvent =
  | { type: "assistant_started"; step: number; entryId?: string }
  | { type: "assistant_text_delta"; step: number; delta: string; entryId?: string }
  | { type: "assistant_thinking_delta"; step: number; delta: string; entryId?: string }
  | { type: "tool_started"; id: string; name: string; args: Record<string, unknown>; phase?: "queued" | "running" }
  | { type: "tool_finished"; id: string; name: string; isError: boolean; error?: string; content?: string };

export type ExecutionEvent =
  | { type: "agent_task_created"; summary: AgentTaskSummary }
  | { type: "agent_task_updated"; summary: AgentTaskSummary }
  | { type: "agent_task_trace"; taskId: string; event: AgentTaskLiveEvent }
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
  | { type: "assistant_started"; step: number; entryId?: string }
  | { type: "assistant_text_delta"; step: number; delta: string; entryId?: string }
  | { type: "assistant_thinking_delta"; step: number; delta: string; entryId?: string }
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
  | { type: "tool_started"; id: string; name: string; args: Record<string, unknown>; phase?: "queued" | "running" }
  | { type: "tool_finished"; id: string; name: string; isError: boolean; error?: string; content?: string }
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
      outcome: "completed" | "interrupted" | "failed";
      error?: string;
      limit?: import("./limits.js").RuntimeLimit;
    };

export type ExecutionEventSink = (event: ExecutionEvent) => void;


export interface RuntimeScope {
  sessionId: string;
  turnId: string;
}

type AssistantEvent = Extract<ExecutionEvent, { type: "assistant_started" | "assistant_text_delta" | "assistant_thinking_delta" | "model_retry_scheduled" | "model_retry_started" }>;
type ToolEvent = Extract<ExecutionEvent, { type: "tool_started" | "tool_finished" }>;
type SessionEvent = Extract<ExecutionEvent, { type: "session_changed" }>;
type OtherEvent = Exclude<ExecutionEvent, AssistantEvent | ToolEvent | SessionEvent | { type: "context_updated" | "agent_task_trace" }>;
type IdentifiedTaskEvent = (Extract<AgentTaskLiveEvent, { type: "assistant_started" | "assistant_text_delta" | "assistant_thinking_delta" }> & { entryId: string })
  | (Extract<AgentTaskLiveEvent, { type: "tool_started" | "tool_finished" }> & { toolCallId: string });

/**
 * Live progress plus committed lifecycle facts. Deltas are ephemeral and may be
 * batched by a client. turn_started/turn_finished follow persistence barriers;
 * this observation stream is not a durable replay log. Unsubscribing does not
 * cancel execution and observer failures cannot change the operation outcome.
 */
export type RuntimeEvent = (RuntimeScope & (
  | OtherEvent
  | (AssistantEvent & { entryId: string })
  | (ToolEvent & { toolCallId: string })
  | { type: "context_updated"; estimatedTokens: number; contextWindow: number }
  | { type: "agent_task_trace"; taskId: string; event: IdentifiedTaskEvent }
)) | (SessionEvent & { turnId: string | null });

export type RuntimeEventSink = (event: RuntimeEvent) => void | Promise<void>;

/** Dispatch without waiting for observers, including asynchronous observers. */
export function safeRuntimeEvent(sink: RuntimeEventSink | undefined, event: RuntimeEvent): void {
  if (!sink) return;
  try {
    const pending = sink(structuredClone(event));
    if (pending) void pending.catch(() => undefined);
  } catch { /* Observers cannot change execution semantics. */ }
}

export function safeExecutionEvent(sink: ExecutionEventSink | undefined, event: ExecutionEvent): void {
  if (!sink) return;
  try { sink(structuredClone(event)); } catch { /* Observers cannot change execution semantics. */ }
}

/** Applies the owning turn identity at the single execution observation boundary. */
export function runtimeEventSink(scope: RuntimeScope, sink?: RuntimeEventSink): ExecutionEventSink {
  return (event) => {
    if (!sink) return;
    let identified: RuntimeEvent;
    switch (event.type) {
      case "assistant_started":
      case "assistant_text_delta":
      case "assistant_thinking_delta":
      case "model_retry_scheduled":
      case "model_retry_started":
        if (!event.entryId) return;
        identified = { ...event, ...scope, entryId: event.entryId };
        break;
      case "tool_started":
      case "tool_finished":
        identified = { ...event, ...scope, toolCallId: event.id };
        break;
      case "context_updated":
        if (event.estimatedTokens === undefined || event.contextWindow === undefined) return;
        identified = { ...scope, type: "context_updated", estimatedTokens: event.estimatedTokens, contextWindow: event.contextWindow };
        break;
      case "agent_task_trace": {
        const child = event.event;
        if (child.type === "tool_started" || child.type === "tool_finished") {
          identified = { ...event, ...scope, event: { ...child, toolCallId: child.id } };
        } else {
          if (!child.entryId) return;
          identified = { ...event, ...scope, event: { ...child, entryId: child.entryId } };
        }
        break;
      }
      default:
        identified = { ...event, ...scope };
    }
    safeRuntimeEvent(sink, identified);
  };
}
