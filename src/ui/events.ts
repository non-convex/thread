import type { ExecutionEvent } from "../core/runtime/events.js";
import type { CommandEvent } from "../app/events.js";

/** Presentation events for TUI commands and execution progress. */
export type UiEvent = ExecutionEvent | CommandEvent
  | { type: "agent_task_trace"; taskId: string; revision: number; event: ExecutionEvent };
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
    // Only the latest byte count matters within a frame; never buffer argument contents.
    if (event.type === "assistant_tool_call_progress" && previous?.type === event.type &&
        previous.entryId === event.entryId && previous.id === event.id && previous.step === event.step) {
      this.pending[this.pending.length - 1] = event;
      return;
    }
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
