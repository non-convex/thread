// Context slicing for the two summary calls.

import type { Context, Message } from "@earendil-works/pi-ai";
import { historySummaryInstruction } from "./history-summary.js";
import type { CompactableUnit } from "./units.js";

function fingerprint(message: Message): string {
  try {
    const serialized = JSON.stringify(message);
    if (serialized === undefined) throw new Error("unserializable");
    return serialized;
  } catch {
    throw new Error("Session message cannot be compared after before_context transformation");
  }
}

/**
 * Find where the Session Tree messages sit inside the full request context.
 * `before_context` extensions may wrap them, but they must stay contiguous and
 * appear exactly once, otherwise cache-preserving slicing is not well defined.
 */
export function locateSessionMessages(
  contextMessages: readonly Message[],
  sessionMessages: readonly Message[],
): number {
  if (contextMessages === sessionMessages) return 0;
  if (sessionMessages.length === 0) return contextMessages.length;
  const haystack = contextMessages.map(fingerprint);
  const needle = sessionMessages.map(fingerprint);
  const matches: number[] = [];
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    if (needle.every((value, offset) => haystack[start + offset] === value)) matches.push(start);
  }
  if (matches.length === 1) return matches[0]!;
  throw new Error(
    "before_context must preserve Session Tree messages as one contiguous sequence for cache-preserving compaction",
  );
}

/**
 * History summary request. The prefix up to the retention cut is sent unchanged
 * and the instruction is appended, so the provider can still reuse the cached
 * prefix from the previous real request.
 */
export function historySummaryContext(
  fullContext: Context,
  sessionMessages: readonly Message[],
  summarizedUnits: readonly CompactableUnit[],
): Context {
  const sessionStart = locateSessionMessages(fullContext.messages, sessionMessages);
  const summarizedCount = summarizedUnits.reduce((total, unit) => total + unit.messages.length, 0);
  return {
    ...fullContext,
    messages: [
      ...fullContext.messages.slice(0, sessionStart + summarizedCount),
      { role: "user", content: historySummaryInstruction(), timestamp: Date.now() },
    ],
  };
}

/**
 * Progress summary request. This is a standalone call over one turn's abandoned
 * trajectory, so it carries no cache expectations and needs no tool schemas.
 */
export function progressSummaryContext(
  fullContext: Context,
  trajectory: readonly Message[],
): Context {
  return {
    ...fullContext,
    messages: trajectory.map((message) => structuredClone(message)),
    tools: [],
  };
}

/** Swap the Session Tree region for the projected messages, keeping any wrapper. */
export function replacementContext(
  sessionMessages: readonly Message[],
  fullContext: Context,
  projectedMessages: readonly Message[],
): Context {
  const sessionStart = locateSessionMessages(fullContext.messages, sessionMessages);
  return {
    ...fullContext,
    messages: [
      ...fullContext.messages.slice(0, sessionStart),
      ...projectedMessages.map((message) => structuredClone(message)),
      ...fullContext.messages.slice(sessionStart + sessionMessages.length),
    ],
  };
}
