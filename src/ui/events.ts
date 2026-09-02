import type { AgentTaskSummary } from "../agent-task/model.js";

export type AgentTaskLiveEvent =
  | { type: "assistant_started"; step: number }
  | { type: "assistant_text_delta"; step: number; delta: string }
  | { type: "assistant_thinking_delta"; step: number; delta: string }
  | { type: "tool_started"; id: string; name: string; args: Record<string, unknown>; phase?: "queued" | "running" }
  | { type: "tool_finished"; id: string; name: string; isError: boolean; error?: string };

export type UiEvent =
  | { type: "agent_task_created"; summary: AgentTaskSummary }
  | { type: "agent_task_updated"; summary: AgentTaskSummary }
  | { type: "agent_task_trace"; taskId: string; event: AgentTaskLiveEvent }
  | { type: "command_started"; name: string }
  | { type: "command_finished"; name: string; ok: boolean }
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
  | { type: "assistant_started"; step: number }
  | { type: "assistant_text_delta"; step: number; delta: string }
  | { type: "assistant_thinking_delta"; step: number; delta: string }
  | {
      type: "model_retry_scheduled";
      step: number;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "model_retry_started"; step: number; attempt: number; maxAttempts: number }
  | { type: "context_updated"; percent: number }
  | { type: "tool_started"; id: string; name: string; args: Record<string, unknown>; phase?: "queued" | "running" }
  | { type: "tool_finished"; id: string; name: string; isError: boolean; error?: string }
  | { type: "compaction_started"; reason: "threshold" | "overflow" | "manual" }
  | { type: "compaction_finished"; reason: "threshold" | "overflow" | "manual"; ok: false }
  | { type: "compaction_finished"; reason: "threshold" | "overflow" | "manual"; ok: true; entryId?: string; summary?: string }
  | { type: "workspace_checkpoint_started" }
  | {
      type: "turn_finished";
      outcome: "completed" | "interrupted" | "failed";
      error?: string;
    };

export type UiEventSink = (event: UiEvent) => void;

export type UiEventBatchSink = (events: readonly UiEvent[]) => void;

/**
 * Reduces every presentation event to one controller notification per terminal
 * frame. Adjacent token deltas are joined, while lifecycle events retain source
 * order inside the batch. Parent and worker streams share the same frame gate.
 */
export class UiEventBatcher {
  private pending: UiEvent[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly target: UiEventBatchSink,
    private readonly intervalMs = 33,
  ) {}

  push(event: UiEvent): void {
    const previous = this.pending.at(-1);
    if ((event.type === "assistant_text_delta" || event.type === "assistant_thinking_delta") &&
        previous?.type === event.type && previous.step === event.step) {
      previous.delta += event.delta;
    } else if (event.type === "agent_task_trace" && previous?.type === "agent_task_trace" &&
        previous.taskId === event.taskId &&
        (event.event.type === "assistant_text_delta" || event.event.type === "assistant_thinking_delta") &&
        previous.event.type === event.event.type && previous.event.step === event.event.step) {
      previous.event.delta += event.event.delta;
    } else {
      this.pending.push(event);
    }
    this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.length === 0) return;
    const events = this.pending;
    this.pending = [];
    try {
      this.target(events);
    } catch {
      // A renderer failure must not alter the durable agent operation.
    }
  }

  dispose(): void {
    this.flush();
  }
}

export function safeUiEvent(sink: UiEventSink | undefined, event: UiEvent): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // Presentation must never change durable execution semantics.
  }
}
