import type { ExecutionEvent } from "../runtime/events.js";

/** Presentation events for TUI commands and execution progress. */
export type UiEvent = ExecutionEvent
  | { type: "command_started"; name: string }
  | { type: "command_finished"; name: string; ok: boolean };
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
        previous?.type === event.type && previous.step === event.step && previous.entryId === event.entryId) {
      previous.delta += event.delta;
    } else if (event.type === "agent_task_trace" && previous?.type === "agent_task_trace" &&
        previous.taskId === event.taskId &&
        (event.event.type === "assistant_text_delta" || event.event.type === "assistant_thinking_delta") &&
        previous.event.type === event.event.type && previous.event.step === event.event.step &&
        previous.event.entryId === event.event.entryId) {
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
  try { sink(event); } catch { /* Rendering cannot change execution semantics. */ }
}
