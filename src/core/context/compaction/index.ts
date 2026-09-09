// Step-based context compaction: one pass, two rolling summaries.

export { ContextCompactionService, type CompactionResult } from "./service.js";
export { prepareCompaction, type CompactionPlan } from "./prepare.js";
export { selectRetained, type RetentionPlan } from "./select.js";
export {
  partitionCompactable,
  unitsMessages,
  unitsTokens,
  unitsToTurns,
  type CompactableUnit,
} from "./units.js";
export { generateHistorySummary, historySummaryInstruction, isHistorySummaryInstruction } from "./history-summary.js";
export { generateProgressSummary, isProgressSummaryInstruction } from "./progress-summary.js";
export {
  collectProgressBackground,
  historySummaryContext,
  progressSummaryContext,
  replacementContext,
  type ProgressBackground,
} from "./slice.js";
export {
  COMPACTION_HISTORY_RESERVE_TOKENS,
  COMPACTION_MIN_RETAINED_STEPS,
  COMPACTION_PROGRESS_PRIOR_TURNS,
  COMPACTION_PROGRESS_RESERVE_TOKENS,
  COMPACTION_SUMMARY_ATTEMPTS,
  COMPACTION_TARGET_TOKENS,
  minimumUsefulSavings,
  retainedBudget,
} from "./policy.js";
