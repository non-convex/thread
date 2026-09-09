// Compaction policy constants — step-based retention with twin rolling summaries.

/** Total live-context budget the retained window is planned against. */
export const COMPACTION_TARGET_TOKENS = 20_000;
/** Reserved for the cumulative cross-turn project-state document. */
export const COMPACTION_HISTORY_RESERVE_TOKENS = 4_000;
/** Reserved for the in-turn progress summary of a partially retained turn. */
export const COMPACTION_PROGRESS_RESERVE_TOKENS = 1_000;
/** Earlier user turns kept as progress-summary background, walking back from the cut. */
export const COMPACTION_PROGRESS_PRIOR_TURNS = 3;
/** Minimum complete steps retained, even when they exceed the token budget. */
export const COMPACTION_MIN_RETAINED_STEPS = 5;
/** Silent retry attempts for each summary call before compaction fails. */
export const COMPACTION_SUMMARY_ATTEMPTS = 3;

export function minimumUsefulSavings(tokensBefore: number): number {
  return Math.min(4_096, Math.max(1_024, Math.floor(tokensBefore * 0.02)));
}

/** Token room available to retained messages once both summaries and overhead are paid for. */
export function retainedBudget(systemTokens: number): number {
  return Math.max(
    0,
    COMPACTION_TARGET_TOKENS -
      COMPACTION_HISTORY_RESERVE_TOKENS -
      COMPACTION_PROGRESS_RESERVE_TOKENS -
      systemTokens,
  );
}
