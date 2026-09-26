export interface DreamerAdmission {
  memoryPath: string;
  memoryRevision: string;
}

export interface DreamerCursor {
  turnId: string;
  offset: number;
}

export interface DreamerCheckpoint {
  cursor?: DreamerCursor;
  evidence: string;
  memoryRevision?: string;
  sourceRevisions: string[];
  /** Disambiguates a newly observed file deletion from an earlier absent-file baseline. */
  missingMemorySince?: number;
  reviewedTurns: number;
  consecutiveFailures: number;
  lastReviewedAt?: number;
  lastResult?: "updated" | "unchanged" | "observed" | "read_only";
  inputBudget?: number;
  modelKey?: string;
  retryAfter?: number;
  lastError?: string;
  blocked?: boolean;
}

export function emptyDreamerCheckpoint(): DreamerCheckpoint {
  return { evidence: "", sourceRevisions: [], reviewedTurns: 0, consecutiveFailures: 0 };
}
