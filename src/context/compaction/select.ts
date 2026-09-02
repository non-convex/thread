// Retention selection: choose the step boundary where verbatim retention starts.

import { COMPACTION_MIN_RETAINED_STEPS, retainedBudget } from "./policy.js";
import { unitsTokens, type CompactableUnit } from "./units.js";

export interface RetentionPlan {
  /** Units before the cut. Their content is folded into the history summary. */
  summarized: CompactableUnit[];
  /** Units kept verbatim, starting at a complete step boundary. */
  retained: CompactableUnit[];
  /**
   * Turn id whose request must be copied into the retained window because the cut
   * landed inside it. Undefined when the cut is already on a turn boundary.
   */
  partialTurnId?: string;
}

/**
 * Pick the first retained unit index. The step floor is hard: tool results are
 * capped at 64KB each, so a bounded number of steps has a bounded size, and a
 * starved working set is worse than a slightly over-budget one. The token budget
 * only decides how many steps beyond the floor are affordable.
 */
export function selectRetained(units: readonly CompactableUnit[], systemTokens: number): RetentionPlan {
  const stepIndexes = units.flatMap((unit, index) => (unit.kind === "step" ? [index] : []));
  if (stepIndexes.length <= COMPACTION_MIN_RETAINED_STEPS) {
    return { summarized: [], retained: [...units] };
  }

  // The floor: start at the Nth-newest step and keep everything after it.
  let cut = stepIndexes[stepIndexes.length - COMPACTION_MIN_RETAINED_STEPS]!;
  let retainedTokens = unitsTokens(units.slice(cut));

  // Extend backward one step at a time while the budget allows. A `user` or
  // `trailing` unit between steps rides along with the step that follows it.
  const budget = retainedBudget(systemTokens);
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
