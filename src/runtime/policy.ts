/** Identifies an execution independently of a selected UI session. */
export interface ExecutionIdentity {
  executionId: string;
  /** Autonomous background work has no single parent session or turn. */
  sessionId: string | null;
  turnId: string | null;
  taskId?: string;
  agentId: string;
}

export interface HostToolCall extends ExecutionIdentity {
  assistantEntryId: string;
  toolCallId: string;
  toolName: string;
  /** A copy of the final validated arguments. Policy cannot rewrite them. */
  args: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export type HostToolDecision = { allow: true } | { allow: false; reason?: string };

/** Runs after extension argument rewriting, for every executor owned by the host. */
export type HostToolPolicy = (call: HostToolCall) => HostToolDecision | Promise<HostToolDecision>;

export interface HostExecutionOptions {
  toolPolicy?: HostToolPolicy;
  sessionIdForTurn?: (turnId: string) => string | undefined;
}
