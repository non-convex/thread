import type { Message, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { ToolExecutionFact } from "../agent/execution-journal.js";
import type { ModelClient } from "../agent/model-client.js";
import type { ToolRegistry } from "../tools/types.js";
import type { WorkspaceScope } from "../workspace-state/model.js";

export const AGENT_TASK_FORMAT = "thread-agent-task-v1" as const;
export const AGENT_TASK_TOOL_NAMES = new Set([
  "delegate_tasks",
  "wait_tasks",
  "inspect_task",
  "request_revision",
  "apply_task",
  "cancel_task",
]);

export interface ImplementationTaskSpec {
  title: string;
  objective: string;
  guidance: string[];
  acceptanceCriteria: string[];
  writeScope: WorkspaceScope[];
}

export type AgentTaskStatus =
  | "preparing"
  | "running"
  | "awaiting_review"
  | "applied"
  | "failed"
  | "cancelled"
  | "discarded";

export interface AgentProfile {
  id: string;
  model: ModelClient;
  thinkingLevel: ModelThinkingLevel;
  limits: {
    maxConcurrent: number;
    maxSteps: number;
    maxRuntimeMs: number;
    maxRevisions: number;
  };
  tools: ToolRegistry;
  systemPrompt: string;
}

export interface AgentTaskRun {
  revision: number;
  startedAt: number;
  finishedAt?: number;
  outcome?: "completed" | "failed" | "cancelled";
  usage?: Usage;
  finalResponse?: string;
  error?: string;
}

export type AgentTaskTraceEntry =
  | { kind: "message"; entryId: string; timestamp: number; message: Message }
  | { kind: "tool_execution"; entryId: string; timestamp: number; fact: ToolExecutionFact };

export interface AgentTask {
  id: string;
  parentTurnId: string;
  toolCallId: string;
  profileId: string;
  providerId: string;
  modelId: string;
  spec: ImplementationTaskSpec;
  status: AgentTaskStatus;
  createdAt: number;
  updatedAt: number;
  baseStateId?: string;
  workspacePath?: string;
  revision: number;
  runs: AgentTaskRun[];
  trace: AgentTaskTraceEntry[];
  currentChangeSetId?: string;
  changeSetIds: string[];
  reviewFeedback: string[];
  error?: string;
  cancelReason?: string;
  appliedStateId?: string;
  integrationError?: string;
}

export interface AgentTaskSummary {
  taskId: string;
  parentTurnId: string;
  toolCallId: string;
  title: string;
  status: AgentTaskStatus;
  profileId: string;
  providerId: string;
  modelId: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  elapsedMs: number;
  contextTokens: number;
  changeSetId?: string;
  changedFiles: number;
  scopeViolations: string[];
  usage?: Usage;
  error?: string;
}

export type AgentTaskEvent =
  | { type: "task_created"; task: AgentTask }
  | { type: "task_prepared"; taskId: string; baseStateId: string; workspacePath: string }
  | { type: "run_started"; taskId: string; run: AgentTaskRun }
  | { type: "run_progress"; taskId: string; revision: number; usage: Usage }
  | { type: "trace_message"; taskId: string; entry: Extract<AgentTaskTraceEntry, { kind: "message" }> }
  | { type: "trace_tool_execution"; taskId: string; entry: Extract<AgentTaskTraceEntry, { kind: "tool_execution" }> }
  | { type: "run_finished"; taskId: string; run: AgentTaskRun }
  | { type: "changeset_created"; taskId: string; changeSetId: string }
  | { type: "revision_requested"; taskId: string; feedback: string }
  | { type: "status_changed"; taskId: string; status: AgentTaskStatus; error?: string; reason?: string }
  | { type: "task_applied"; taskId: string; changeSetId: string; stateId: string }
  | { type: "integration_failed"; taskId: string; changeSetId: string; conflicts: string[] };

export type AgentTaskRecord = {
  format: typeof AGENT_TASK_FORMAT;
  formatVersion: 1;
  sequence: number;
  timestamp: number;
} & AgentTaskEvent;

export interface AgentProfileDiagnostic {
  profileId: string;
  level: "warning" | "error";
  message: string;
}
