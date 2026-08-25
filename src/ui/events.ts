import type { ToolResult } from "../tools/types.js";

export type UiEvent =
  | { type: "command_started"; name: string }
  | { type: "command_finished"; name: string; ok: boolean }
  | {
      type: "session_changed";
      sessionId: string;
      branch: string;
      checkpointId: string;
      reason: "new" | "switch";
    }
  | {
      type: "head_changed";
      branch: string;
      checkpointId: string;
      reason: "turn" | "command" | "switch" | "restore" | "merge" | "recovery";
    }
  | { type: "turn_started"; turnId: string; userEntryId?: string; input: string; branch: string }
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
  private pendingThinking = "";
  private pendingStep = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly target: UiEventSink,
    private readonly intervalMs = 24,
  ) {}

  push(event: UiEvent): void {
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
