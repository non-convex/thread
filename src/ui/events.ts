import type { ToolResult } from "../tools/types.js";

export type UiEvent =
  | { type: "command_started"; name: string }
  | { type: "command_finished"; name: string; ok: boolean }
  | {
      type: "head_changed";
      branch: string;
      checkpointId: string;
      reason: "turn" | "command" | "switch" | "restore" | "merge" | "recovery";
    }
  | { type: "turn_started"; turnId: string; input: string; branch: string }
  | { type: "assistant_started"; step: number }
  | { type: "assistant_text_delta"; step: number; delta: string }
  | { type: "tool_started"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_finished"; id: string; name: string; result: ToolResult; isError: boolean }
  | { type: "compaction_started"; reason: "threshold" | "overflow" | "manual" }
  | { type: "compaction_finished"; ok: boolean }
  | {
      type: "turn_finished";
      outcome: "completed" | "aborted" | "failed";
      checkpointId?: string;
      error?: string;
    };

export type UiEventSink = (event: UiEvent) => void;

/** Keeps model token cadence independent from terminal frame cadence. */
export class UiEventBatcher {
  private pendingText = "";
  private pendingStep = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly target: UiEventSink,
    private readonly intervalMs = 24,
  ) {}

  push(event: UiEvent): void {
    if (event.type === "assistant_text_delta") {
      if (this.pendingText && event.step !== this.pendingStep) this.flush();
      this.pendingStep = event.step;
      this.pendingText += event.delta;
      this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
      return;
    }
    this.flush();
    this.target(event);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pendingText) return;
    const event: UiEvent = {
      type: "assistant_text_delta",
      step: this.pendingStep,
      delta: this.pendingText,
    };
    this.pendingText = "";
    this.target(event);
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
