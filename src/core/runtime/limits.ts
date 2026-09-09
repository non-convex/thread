export type RuntimeLimit = "maxSteps" | "timeout";

export interface ExecutionLimits {
  /** Model steps, including an overflow-recovery response; transport retries do not add steps. */
  maxSteps?: number;
  /** Cooperative wall-clock budget, including compaction and tool cleanup. */
  timeoutMs?: number;
}

export class RuntimeLimitError extends Error {
  constructor(readonly limit: RuntimeLimit, readonly value: number) {
    super(limit === "maxSteps" ? `Turn reached its limit of ${value} model steps` : `Turn exceeded its ${value}ms runtime limit`);
    this.name = "RuntimeLimitError";
  }
}

export function validateExecutionLimits(limits: ExecutionLimits): void {
  if (limits.maxSteps !== undefined && (!Number.isSafeInteger(limits.maxSteps) || limits.maxSteps < 1)) {
    throw new RangeError("maxSteps must be a positive safe integer");
  }
  if (limits.timeoutMs !== undefined && (!Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1 || limits.timeoutMs > 2_147_483_647)) {
    throw new RangeError("timeoutMs must be a positive integer no greater than 2147483647");
  }
}

/** The timer requests cancellation; callers must still await execution settlement. */
export function executionDeadline(signal: AbortSignal, timeoutMs?: number): { signal: AbortSignal; dispose(): void } {
  if (timeoutMs === undefined) return { signal, dispose() {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new RuntimeLimitError("timeout", timeoutMs)), timeoutMs);
  return {
    signal: AbortSignal.any([signal, controller.signal]),
    dispose: () => clearTimeout(timer),
  };
}
