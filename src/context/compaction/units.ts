// Step-level partitioning: flatten turn projections into indivisible units.

import type { Message } from "@earendil-works/pi-ai";
import type { RetainedTurn } from "../../session-tree/model.js";
import { estimateMessageTokens } from "../../utils/estimate.js";

/**
 * One indivisible piece of the compactable region.
 *
 * - `user` is a turn's request.
 * - `step` is one assistant response with every matching tool result.
 * - `trailing` is a tool batch that is not yet complete. It can never be split,
 *   because cutting it would leave an orphaned tool call or result in the context.
 */
export interface CompactableUnit {
  kind: "user" | "step" | "trailing";
  turnId: string;
  messages: Message[];
}

/**
 * Parse one assistant response and every matching tool result. Returns undefined
 * for an incomplete or malformed step instead of guessing at a cut point.
 */
function parseCompleteStep(
  messages: readonly Message[],
  start: number,
): { step: Message[]; end: number } | undefined {
  const assistant = messages[start];
  if (!assistant || assistant.role !== "assistant") return undefined;
  const callIds = assistant.content
    .filter((block) => block.type === "toolCall")
    .map((block) => (block.type === "toolCall" ? block.id : ""));
  let end = start + 1;
  while (end < messages.length && messages[end]!.role !== "assistant") end++;
  const step = messages.slice(start, end);
  const expected = new Set(callIds);
  const received = new Set<string>();
  for (const message of step.slice(1)) {
    if (message.role !== "toolResult" || !expected.has(message.toolCallId) || received.has(message.toolCallId)) {
      return undefined;
    }
    received.add(message.toolCallId);
  }
  if (received.size !== expected.size) return undefined;
  return { step: [...step], end };
}

/**
 * Flatten turn-grouped projections into ordered units. Step boundaries are the
 * only cut points compaction may use.
 */
export function partitionCompactable(turns: readonly RetainedTurn[]): CompactableUnit[] {
  const units: CompactableUnit[] = [];
  for (const turn of turns) {
    let index = 0;
    while (index < turn.messages.length) {
      const message = turn.messages[index]!;
      if (message.role === "user") {
        units.push({ kind: "user", turnId: turn.turnId, messages: [message] });
        index += 1;
        continue;
      }
      const parsed = parseCompleteStep(turn.messages, index);
      if (parsed) {
        units.push({ kind: "step", turnId: turn.turnId, messages: parsed.step });
        index = parsed.end;
        continue;
      }
      // An unparseable remainder is one indivisible trailing unit: an in-flight
      // batch only ever appears at the end of the newest turn.
      units.push({ kind: "trailing", turnId: turn.turnId, messages: turn.messages.slice(index) });
      break;
    }
  }
  return units;
}

export function unitsTokens(units: readonly CompactableUnit[]): number {
  let total = 0;
  for (const unit of units) {
    for (const message of unit.messages) total += estimateMessageTokens(message);
  }
  return total;
}

export function unitsMessages(units: readonly CompactableUnit[]): Message[] {
  return units.flatMap((unit) => unit.messages.map((message) => structuredClone(message)));
}

/**
 * Regroup units into turn projections, preserving path order. `partialTurnRequest`
 * is prepended when the retained window starts mid-turn, so every stored
 * projection still begins with a user message.
 */
export function unitsToTurns(
  units: readonly CompactableUnit[],
  partialTurnRequest?: Message,
): RetainedTurn[] {
  const turns: RetainedTurn[] = [];
  for (const unit of units) {
    const last = turns[turns.length - 1];
    if (!last || last.turnId !== unit.turnId) {
      const messages = unit.messages.map((message) => structuredClone(message));
      if (turns.length === 0 && partialTurnRequest && unit.kind !== "user") {
        messages.unshift(structuredClone(partialTurnRequest));
      }
      turns.push({ turnId: unit.turnId, messages });
      continue;
    }
    for (const message of unit.messages) last.messages.push(structuredClone(message));
  }
  return turns;
}
