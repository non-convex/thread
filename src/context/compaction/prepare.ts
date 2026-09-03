// Plan one compaction pass: partition into steps, choose the cut, verify benefit.

import type { Message } from "@earendil-works/pi-ai";
import type { RetainedTurn } from "../../session-tree/model.js";
import { estimateMessageTokens } from "../usage.js";
import type { BuiltContext } from "../builder.js";
import {
  COMPACTION_HISTORY_RESERVE_TOKENS,
  COMPACTION_PROGRESS_RESERVE_TOKENS,
  minimumUsefulSavings,
} from "./policy.js";
import { selectRetained } from "./select.js";
import { partitionCompactable, unitsMessages, unitsToTurns, unitsTokens, type CompactableUnit } from "./units.js";

export interface CompactionPlan {
  /** Units folded into the history summary. */
  summarizedUnits: CompactableUnit[];
  /** Units kept verbatim. */
  retainedUnits: CompactableUnit[];
  /**
   * The partially retained turn's abandoned trajectory, summarized separately so
   * the copied request is not left without context. Absent for a clean cut.
   */
  partialTurnTrajectory?: Message[];
  /** Retained turns as Session Tree projections, each beginning with a user message. */
  retainedTurns: RetainedTurn[];
  estimatedSavings: number;
}

export function prepareCompaction(built: BuiltContext, systemTokens: number): CompactionPlan | undefined {
  const units = partitionCompactable(built.compactableTurns);
  const selection = selectRetained(units, systemTokens);
  if (selection.summarized.length === 0) return undefined;

  const partial = selection.partialTurnId === undefined
    ? undefined
    : partialTurnContinuity(selection.summarized, selection.partialTurnId);
  // A mid-turn cut with no recoverable request cannot be projected safely.
  if (selection.partialTurnId !== undefined && !partial) return undefined;

  const tokensBefore = built.messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
  const tokensAfter = COMPACTION_HISTORY_RESERVE_TOKENS +
    (partial ? COMPACTION_PROGRESS_RESERVE_TOKENS : 0) +
    unitsTokens(selection.retained);
  const estimatedSavings = tokensBefore - tokensAfter;
  if (estimatedSavings < minimumUsefulSavings(tokensBefore)) return undefined;

  return {
    summarizedUnits: selection.summarized,
    retainedUnits: selection.retained,
    ...(partial ? { partialTurnTrajectory: partial.trajectory } : {}),
    retainedTurns: unitsToTurns(selection.retained, partial?.request),
    estimatedSavings,
  };
}

/**
 * Recover the request and abandoned trajectory of the turn the cut landed inside.
 * Both come from the summarized side, which still holds that turn's earlier units.
 */
function partialTurnContinuity(
  summarized: readonly CompactableUnit[],
  partialTurnId: string,
): { request: Message; trajectory: Message[] } | undefined {
  const own = summarized.filter((unit) => unit.turnId === partialTurnId);
  const request = own.find((unit) => unit.kind === "user")?.messages[0];
  if (!request) return undefined;
  return {
    request,
    trajectory: unitsMessages(own),
  };
}
