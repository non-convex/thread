import type { Message, Usage } from "@earendil-works/pi-ai";
import type { ToolExecutionFact } from "../agent/execution-journal.js";
import type { BuiltinToolName } from "../tools/builtins.js";
import type { FileWriteScope as AgentTaskWriteScope } from "../tools/path-safety.js";
export type { FileWriteScope as AgentTaskWriteScope } from "../tools/path-safety.js";

export const AGENT_TASK_FORMAT = "thread-agent-task-v3" as const;
export const AGENT_TASK_TOOL_NAMES = new Set([
  "delegate_tasks",
  "wait_tasks",
  "request_revision",
  "cancel_task",
]);

export interface WorkerTaskSpec {
  title: string;
  objective: string;
  guidance: string[];
  acceptanceCriteria: string[];
  /** Exact built-in tools available to this task, including revisions. May be empty. */
  tools: BuiltinToolName[];
  /** Empty for tasks that must not modify files; required when write or edit is assigned. */
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
  spec: WorkerTaskSpec;
  status: AgentTaskStatus;
  createdAt: number;
  updatedAt: number;
  revision: number;
  runs: AgentTaskRun[];
  trace: AgentTaskTraceEntry[];
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
  | { type: "status_changed"; taskId: string; status: AgentTaskStatus; error?: string; reason?: string };

export type AgentTaskRecord = {
  format: typeof AGENT_TASK_FORMAT;
  formatVersion: 3;
  sequence: number;
  timestamp: number;
} & AgentTaskEvent;
