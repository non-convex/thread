import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { PreparedToolCall } from "./tool-call-executor.js";

const REPEATED_RESULT_THRESHOLD = 3;
const MAX_REMINDERS_PER_RUN = 3;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

/** Advisory only: identical polling is not proof that a task is stuck. */
export class ToolLoopGuard {
  private previous: string | undefined;
  private streak = 0;
  private reminders = 0;

  reset(): void {
    this.previous = undefined;
    this.streak = 0;
    this.reminders = 0;
  }

  observe(call: PreparedToolCall, result: Message): string | undefined {
    if (call.policy.effect === "interactive" || result.role !== "toolResult") {
      this.previous = undefined;
      this.streak = 0;
      return undefined;
    }
    // Ignore call ids, timings and presentation metadata. A changing result is
    // useful new information even when the tool and its arguments are unchanged.
    const signature = createHash("sha256").update(JSON.stringify([
      call.call.name, stableValue(call.args), result.isError, result.content,
    ])).digest("hex");
    this.streak = signature === this.previous ? this.streak + 1 : 1;
    this.previous = signature;
    if (this.streak !== REPEATED_RESULT_THRESHOLD || this.reminders >= MAX_REMINDERS_PER_RUN) return undefined;
    this.reminders++;
    return `[Runtime reminder: ${call.call.name} has returned the same result for the same arguments ${this.streak} times in a row. Use the existing result to choose a different next step or explain the blocker. If this is intentional polling, continue only when waiting can change the result. This reminder does not change the user's task or authorization.]`;
  }
}
