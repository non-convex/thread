import type { ToolResult } from "../tools/types.js";
import type { AgentTaskSummary } from "../agent-task/model.js";

export type AgentTaskLiveEvent =
  | { type: "assistant_started"; step: number }
  | { type: "assistant_text_delta"; step: number; delta: string }
  | { type: "assistant_thinking_delta"; step: number; delta: string }
  | { type: "tool_started"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_finished"; id: string; name: string; result: ToolResult; isError: boolean };

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
  | { type: "tool_started"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_finished"; id: string; name: string; result: ToolResult; isError: boolean }
  | { type: "compaction_started"; reason: "threshold" | "overflow" | "manual" }
  | { type: "compaction_finished"; reason: "threshold" | "overflow" | "manual"; ok: false }
  | { type: "compaction_finished"; reason: "threshold" | "overflow" | "manual"; ok: true; entryId?: string }
  | {
      type: "turn_finished";
      outcome: "completed" | "interrupted" | "failed";
      error?: string;
    };

export type UiEventSink = (event: UiEvent) => void;

/** Worker token streams are batched per task so they cannot dictate parent-frame cadence. */
class AgentTaskEventBatcher {
  private readonly pending = new Map<string, {
    step: number;
    type: "assistant_text_delta" | "assistant_thinking_delta";
    delta: string;
    timer: NodeJS.Timeout;
  }>();

  constructor(private readonly target: UiEventSink, private readonly intervalMs: number) {}

  push(event: Extract<UiEvent, { type: "agent_task_trace" }>): void {
    const child = event.event;
    if (child.type !== "assistant_text_delta" && child.type !== "assistant_thinking_delta") {
      this.flush(event.taskId);
      this.target(event);
      return;
    }
    const existing = this.pending.get(event.taskId);
    if (existing && existing.step === child.step && existing.type === child.type) {
      existing.delta += child.delta;
      return;
    }
    this.flush(event.taskId);
    const timer = setTimeout(() => this.flush(event.taskId), this.intervalMs);
    this.pending.set(event.taskId, { step: child.step, type: child.type, delta: child.delta, timer });
  }

  flush(taskId?: string): void {
    const ids = taskId === undefined ? [...this.pending.keys()] : [taskId];
    for (const id of ids) {
      const item = this.pending.get(id);
      if (!item) continue;
      clearTimeout(item.timer);
      this.pending.delete(id);
      this.target({ type: "agent_task_trace", taskId: id, event: { type: item.type, step: item.step, delta: item.delta } });
    }
  }
}

/** Keeps model token cadence independent from terminal frame cadence. */
export class UiEventBatcher {
  private pendingText = "";
  private pendingThinking = "";
  private pendingStep = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly agentTasks: AgentTaskEventBatcher;

  constructor(
    private readonly target: UiEventSink,
    private readonly intervalMs = 24,
  ) {
    this.agentTasks = new AgentTaskEventBatcher((event) => this.emit(event), Math.max(48, intervalMs * 2));
  }

  push(event: UiEvent): void {
    if (event.type === "agent_task_trace") {
      this.agentTasks.push(event);
      return;
    }
    if (event.type === "agent_task_updated") this.agentTasks.flush(event.summary.taskId);
    if (event.type === "assistant_text_delta" || event.type === "assistant_thinking_delta") {
      if (event.step !== this.pendingStep) this.flush();
      if (event.type === "assistant_text_delta" && this.pendingThinking) this.flush();
      if (event.type === "assistant_thinking_delta" && this.pendingText) this.flush();
      this.pendingStep = event.step;
      if (event.type === "assistant_text_delta") this.pendingText += event.delta;
      else this.pendingThinking += event.delta;
      this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
      return;
    }
    this.flush();
    this.emit(event);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pendingThinking) {
      const event: UiEvent = {
        type: "assistant_thinking_delta",
        step: this.pendingStep,
        delta: this.pendingThinking,
      };
      this.pendingThinking = "";
      this.emit(event);
    }
    if (this.pendingText) {
      const event: UiEvent = {
        type: "assistant_text_delta",
        step: this.pendingStep,
        delta: this.pendingText,
      };
      this.pendingText = "";
      this.emit(event);
    }
  }

  dispose(): void {
    this.flush();
    this.agentTasks.flush();
  }

  private emit(event: UiEvent): void {
    try {
      this.target(event);
    } catch {
      // A renderer failure must not alter the durable agent operation.
    }
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
