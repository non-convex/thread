import type { Message, Usage } from "@earendil-works/pi-ai";
import type { ToolExecutionFact } from "../agent/execution-journal.js";

// Source-level compatibility for callers while shared profile types live in agent/.
export type { AgentProfile, AgentProfileDiagnostic } from "../agent/profile.js";

export const AGENT_TASK_FORMAT = "thread-agent-task-v2" as const;
export const AGENT_TASK_TOOL_NAMES = new Set([
  "delegate_tasks",
  "wait_tasks",
  "request_revision",
  "cancel_task",
]);

export interface AgentTaskWriteScope {
  path: string;
  kind: "file" | "directory";
}

export interface ImplementationTaskSpec {
  title: string;
  objective: string;
  guidance: string[];
  acceptanceCriteria: string[];
  writeScope: AgentTaskWriteScope[];
}

export type AgentTaskStatus = "running" | "completed" | "failed" | "cancelled";

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
  revision: number;
  runs: AgentTaskRun[];
  trace: AgentTaskTraceEntry[];
  reviewFeedback: string[];
  error?: string;
  cancelReason?: string;
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
  usage?: Usage;
  error?: string;
}

export type AgentTaskEvent =
  | { type: "task_created"; task: AgentTask }
  | { type: "run_started"; taskId: string; run: AgentTaskRun }
  | { type: "run_progress"; taskId: string; revision: number; usage: Usage }
  | { type: "trace_message"; taskId: string; entry: Extract<AgentTaskTraceEntry, { kind: "message" }> }
  | { type: "trace_tool_execution"; taskId: string; entry: Extract<AgentTaskTraceEntry, { kind: "tool_execution" }> }
  | { type: "run_finished"; taskId: string; run: AgentTaskRun }
  | { type: "revision_requested"; taskId: string; feedback: string }
  | { type: "status_changed"; taskId: string; status: AgentTaskStatus; error?: string; reason?: string };

export type AgentTaskRecord = {
  format: typeof AGENT_TASK_FORMAT;
  formatVersion: 2;
  sequence: number;
  timestamp: number;
} & AgentTaskEvent;
