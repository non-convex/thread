// Context slicing for the two summary calls.

import type { Context, Message } from "@earendil-works/pi-ai";
import type { BuiltContext } from "../builder.js";
import type { RetainedTurn } from "../../session-tree/model.js";
import { historySummaryInstruction } from "./history-summary.js";
import { COMPACTION_PROGRESS_PRIOR_TURNS } from "./policy.js";
import { PROGRESS_SUMMARY_SYSTEM_PROMPT } from "./progress-summary.js";
import type { CompactableUnit } from "./units.js";

export interface ProgressBackground {
  /** Previous cumulative project-state document, included when the walk hits it. */
  historySummary?: string;
  /** Earlier user turns, oldest first, each with only its final text reply. */
  priorTurns: Array<{ user: Message; lastReply?: Message }>;
}

function hasToolCall(message: Message): boolean {
  return message.role === "assistant" && message.content.some((block) => block.type === "toolCall");
}

/** The last model reply of a finished turn: text only, no thinking or tool calls. */
function lastTextReply(turn: RetainedTurn): Message | undefined {
  for (let index = turn.messages.length - 1; index >= 0; index--) {
    const message = turn.messages[index]!;
    if (message.role !== "assistant" || hasToolCall(message)) continue;
    const textBlocks = message.content.filter((block) => block.type === "text");
    if (textBlocks.length === 0) return undefined;
    const reply = structuredClone(message);
    reply.content = structuredClone(textBlocks);
    return reply;
  }
  return undefined;
}

/**
 * Background for a mid-turn progress summary. Walk backward from the partial
 * turn and keep at most three earlier user turns. If those three slots are not
 * filled, take the previous history document and stop rather than reconstructing
 * pre-compaction raw history.
 */
export function collectProgressBackground(built: BuiltContext, partialTurnId: string): ProgressBackground {
  const partialIndex = built.compactableTurns.findIndex((turn) => turn.turnId === partialTurnId);
  const prior = partialIndex < 0 ? built.compactableTurns : built.compactableTurns.slice(0, partialIndex);
  const picked = prior.slice(-COMPACTION_PROGRESS_PRIOR_TURNS);
  const priorTurns: ProgressBackground["priorTurns"] = [];
  for (const turn of picked) {
    const userMessage = turn.messages.find((message) => message.role === "user");
    if (!userMessage) continue;
    const lastReply = lastTextReply(turn);
    priorTurns.push({
      user: structuredClone(userMessage),
      ...(lastReply ? { lastReply } : {}),
    });
  }
  const historySummary = picked.length < COMPACTION_PROGRESS_PRIOR_TURNS
    ? built.latestCompaction?.summary?.trim()
    : undefined;
  return {
    ...(historySummary ? { historySummary } : {}),
    priorTurns,
  };
}

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
  retainedUnits: readonly CompactableUnit[],
): Context {
  const sessionStart = locateSessionMessages(fullContext.messages, sessionMessages);
  // Retained units form the raw-message suffix. Count back from its end so the
  // earlier history document and checkpoint remain in the summarized prefix.
  const retainedCount = retainedUnits.reduce((total, unit) => total + unit.messages.length, 0);
  const retentionCut = sessionStart + sessionMessages.length - retainedCount;
  return {
    ...fullContext,
    messages: [
      ...fullContext.messages.slice(0, retentionCut),
      { role: "user", content: historySummaryInstruction(), timestamp: Date.now() },
    ],
  };
}

/**
 * Progress summary request. It has a dedicated compaction prompt instead of the
 * main agent prompt. Background is the previous history document (when the walk
 * reaches it) plus up to three earlier user turns; only the abandoned trajectory
 * from the current turn is the summarization target.
 */
export function progressSummaryContext(
  background: ProgressBackground,
  trajectory: readonly Message[],
): Context {
  const timestamp = Date.now();
  const messages: Message[] = [];
  if (background.historySummary) {
    messages.push({
      role: "user",
      content: [
        "[Project-state background — background only]",
        background.historySummary,
        "[End project-state background]",
      ].join("\n"),
      timestamp,
    });
  }
  for (const turn of background.priorTurns) {
    messages.push(structuredClone(turn.user));
    if (turn.lastReply) messages.push(structuredClone(turn.lastReply));
  }
  if (background.historySummary || background.priorTurns.length > 0) {
    messages.push({ role: "user", content: "[Current-turn content to summarize follows]", timestamp });
  }
  messages.push(...trajectory.map((message) => structuredClone(message)));
  return {
    systemPrompt: PROGRESS_SUMMARY_SYSTEM_PROMPT,
    messages,
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
