import type { ToolResult } from "./types.js";

export function ok(content: string, details?: unknown): ToolResult {
  return { content, isError: false, ...(details === undefined ? {} : { details }) };
}

export function fail(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true };
}

export function limited(value: string, max = 64 * 1024): string {
  if (Buffer.byteLength(value, "utf8") <= max) return value;
  return `${Buffer.from(value, "utf8").subarray(0, max).toString("utf8")}\n[output truncated at ${max} bytes]`;
}

export function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, Math.floor(value)));
}
