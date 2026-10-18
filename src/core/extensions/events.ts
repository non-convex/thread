import type { Context, ImageContent } from "@earendil-works/pi-ai";
import type { ToolResult } from "../tools/types.js";

/** Main-agent transforms only; worker and Dreamer executions use host policies instead. */
export interface ExtensionEventMap {
  /** Failure ends the admitted turn before its first model request. */
  turn_start: { turnId: string; sessionId: string; input: string };
  /** Failure aborts context construction, including manual compaction. */
  before_context: { context: Context; turnId: string };
  /** Failure stops preflight; it never authorizes the call. Received output is retained as a failed attempt. */
  before_tool_call: {
    toolName: string;
    args: Record<string, unknown>;
    denied?: boolean;
    denyReason?: string;
  };
  /**
   * Changes model-facing content only. Original tool output remains in durable details.raw.
   * Failure falls back to the original content plus a diagnostic; this is not a confidentiality boundary.
   */
  tool_result: { toolName: string; raw: ToolResult; modelContent: string; modelImages?: readonly ImageContent[] };
  /** Runs after durable turn completion. Failure is ignored and cannot change that outcome. */
  turn_end: { turnId: string; outcome: "completed" | "interrupted" | "failed" };
}

export type ExtensionEventType = keyof ExtensionEventMap;
export type ExtensionHandler<K extends ExtensionEventType> = (
  event: ExtensionEventMap[K],
) => void | ExtensionEventMap[K] | Promise<void | ExtensionEventMap[K]>;

export class ExtensionEvents {
  private readonly handlers = new Map<ExtensionEventType, Set<(event: unknown) => unknown | Promise<unknown>>>();

  on<K extends ExtensionEventType>(type: K, handler: ExtensionHandler<K>): () => void {
    const current = this.handlers.get(type) ?? new Set();
    const stored = handler as (event: unknown) => unknown | Promise<unknown>;
    current.add(stored);
    this.handlers.set(type, current);
    return () => current.delete(stored);
  }

  hasHandlers(type: ExtensionEventType): boolean {
    return (this.handlers.get(type)?.size ?? 0) > 0;
  }

  async emit<K extends ExtensionEventType>(type: K, initial: ExtensionEventMap[K]): Promise<ExtensionEventMap[K]> {
    let event = initial;
    for (const handler of this.handlers.get(type) ?? []) {
      const transformed = await handler(event);
      if (transformed !== undefined) event = transformed as ExtensionEventMap[K];
    }
    return event;
  }
}
