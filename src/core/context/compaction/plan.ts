// Plan one compaction pass: partition into steps, choose the cut, verify benefit.
// Step-based retention with twin rolling summaries.

import type { Message } from "@earendil-works/pi-ai";
import type { RetainedTurn } from "../../session-tree/model.js";
import { estimateMessageTokens } from "../usage.js";
import type { BuiltContext } from "../builder.js";
import { partitionCompactable, unitsMessages, unitsToTurns, unitsTokens, type CompactableUnit } from "./units.js";

/** Total live-context budget the retained window is planned against. */
const COMPACTION_TARGET_TOKENS = 25_000;
/** Reserved for the cumulative cross-turn project-state document. */
const COMPACTION_HISTORY_RESERVE_TOKENS = 4_000;
/** Reserved for the in-turn progress summary of a partially retained turn. */
const COMPACTION_PROGRESS_RESERVE_TOKENS = 1_000;
/** Minimum complete steps retained, even when they exceed the token budget. */
const COMPACTION_MIN_RETAINED_STEPS = 5;

export function minimumUsefulSavings(tokensBefore: number): number {
  return Math.min(4_096, Math.max(1_024, Math.floor(tokensBefore * 0.02)));
}

export interface CompactionPlan {
  /** Units folded into the history summary. */
  summarizedUnits: CompactableUnit[];
  /** Units kept verbatim. */
  retainedUnits: CompactableUnit[];
  /**
   * Turn id whose request must be copied into the retained window because the cut
   * landed inside it. Undefined when the cut is already on a turn boundary.
   */
  partialTurnId?: string;
  /**
   * The partially retained turn's abandoned trajectory, summarized separately so
   * the copied request is not left without context. Absent for a clean cut.
   */
  partialTurnTrajectory?: Message[];
  /** Retained turns as Session Tree projections, each beginning with a user message. */
  retainedTurns: RetainedTurn[];
}

interface RetentionPlan {
  summarized: CompactableUnit[];
  retained: CompactableUnit[];
  partialTurnId?: string;
}

/**
 * Pick the first retained unit index. The step floor is hard: tool results are
 * capped at 64KB each, so a bounded number of steps has a bounded size, and a
 * starved working set is worse than a slightly over-budget one. The token budget
 * only decides how many steps beyond the floor are affordable.
 */
function selectRetained(units: readonly CompactableUnit[], systemTokens: number): RetentionPlan {
  const stepIndexes = units.flatMap((unit, index) => (unit.kind === "step" ? [index] : []));
  if (stepIndexes.length <= COMPACTION_MIN_RETAINED_STEPS) {
    return { summarized: [], retained: [...units] };
  }

  // The floor: start at the Nth-newest step and keep everything after it.
  let cut = stepIndexes[stepIndexes.length - COMPACTION_MIN_RETAINED_STEPS]!;
  let retainedTokens = unitsTokens(units.slice(cut));

  // Extend backward one step at a time while the budget allows. A `user` or
  // `trailing` unit between steps rides along with the step that follows it.
  const budget = Math.max(0, COMPACTION_TARGET_TOKENS - COMPACTION_HISTORY_RESERVE_TOKENS -
    COMPACTION_PROGRESS_RESERVE_TOKENS - systemTokens);
  for (let index = stepIndexes.length - COMPACTION_MIN_RETAINED_STEPS - 1; index >= 0; index--) {
    const candidate = stepIndexes[index]!;
    const addedTokens = unitsTokens(units.slice(candidate, cut));
    if (retainedTokens + addedTokens > budget) break;
    cut = candidate;
    retainedTokens += addedTokens;
  }

  const retained = units.slice(cut);
  const first = retained[0];
  if (!first) return { summarized: [...units], retained: [] };

  // A cut sitting immediately after its own turn's request is not really
  // mid-turn: absorbing that one request yields a clean turn boundary and
  // avoids an unnecessary progress-summary call.
  const previous = cut > 0 ? units[cut - 1] : undefined;
  if (first.kind !== "user" && previous?.kind === "user" && previous.turnId === first.turnId) {
    return { summarized: units.slice(0, cut - 1), retained: units.slice(cut - 1) };
  }

  return {
    summarized: units.slice(0, cut),
    retained,
    // A cut that does not begin a turn needs that turn's request copied in.
    ...(first.kind !== "user" ? { partialTurnId: first.turnId } : {}),
  };
}

export function prepareCompaction(built: BuiltContext, systemTokens: number): CompactionPlan | undefined {
  const units = partitionCompactable(built.compactableTurns);
  const selection = selectRetained(units, systemTokens);
  if (selection.summarized.length === 0) return undefined;

  // Recover the request and abandoned trajectory of the turn the cut landed inside.
  // Both come from the summarized side, which still holds that turn's earlier units.
  const own = selection.partialTurnId === undefined
    ? undefined
    : selection.summarized.filter((unit) => unit.turnId === selection.partialTurnId);
  const request = own?.find((unit) => unit.kind === "user")?.messages[0];
  // A mid-turn cut with no recoverable request cannot be projected safely.
  if (own && !request) return undefined;

  const tokensBefore = built.messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
  const tokensAfter = COMPACTION_HISTORY_RESERVE_TOKENS +
    (own ? COMPACTION_PROGRESS_RESERVE_TOKENS : 0) +
    unitsTokens(selection.retained);
  if (tokensBefore - tokensAfter < minimumUsefulSavings(tokensBefore)) return undefined;

  return {
    summarizedUnits: selection.summarized,
    retainedUnits: selection.retained,
    ...(own && selection.partialTurnId !== undefined
      ? { partialTurnId: selection.partialTurnId, partialTurnTrajectory: unitsMessages(own) }
      : {}),
    retainedTurns: unitsToTurns(selection.retained, request),
  };
}
