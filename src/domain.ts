import type { Message, Usage } from "@earendil-works/pi-ai";

export type CheckpointReason =
  | "genesis"
  | "turn_base"
  | "turn_result"
  | "safety"
  | "command"
  | "recovery"
  | "merge";

export interface ProjectSession {
  id: string;
  rootPath: string;
  currentBranch: string;
  createdAt: number;
  updatedAt: number;
}

export interface EntryBase {
  id: string;
  sessionId: string;
  seq: number;
  parentId: string | null;
  timestamp: number;
}

export type SessionEntry =
  | (EntryBase & { type: "message"; message: Message })
  | (EntryBase & {
      type: "compaction";
      summary: string;
      retainedTail: Message[];
      tokensBefore: number;
    })
  | (EntryBase & {
      type: "context_merge";
      sourceRef: string;
      sourceCheckpointId: string;
      commonAncestorCheckpointId: string | null;
      content: string;
    })
  | (EntryBase & { type: "custom"; customType: string; data?: unknown });

export interface RecordBase {
  id: string;
  seq: number;
  lane: string;
  timestamp: number;
}

export interface OperationStartedRecord extends RecordBase {
  type: "operation_started";
  sourceLeafId: string | null;
  intent:
    | { kind: "run"; originalPrompt: Message[]; initialEntryIds: string[] }
    | { kind: "compaction"; resultEntryId: string; customInstructions?: string }
    | {
        kind: "navigation";
        targetId: string | null;
        summarize: boolean;
        customInstructions?: string;
        label?: string;
        summaryEntryId?: string;
      };
}

export interface OperationFinishedRecord extends RecordBase {
  type: "operation_finished";
  runId: string;
  outcome: "completed" | "aborted" | "failed" | "declined";
  error?: { code: string; message: string };
}

export interface StepAttemptRecord extends RecordBase {
  type: "step_attempt";
  runId: string;
  step: "assistant" | "branch_summary" | "compaction";
  attempt: number;
  resultEntryId: string;
  compactionReason?: "manual" | "threshold" | "overflow";
}

export interface ToolStartedRecord extends RecordBase {
  type: "tool_started";
  runId: string;
  assistantEntryId: string;
  toolIndex: number;
  toolCallId: string;
  toolName: string;
  effectiveArgs: Record<string, unknown>;
  resultEntryId: string;
  replay: "safe" | "never";
}

export type DurableRecord = OperationStartedRecord | OperationFinishedRecord | StepAttemptRecord | ToolStartedRecord;

export interface InternalCheckpoint {
  id: string;
  sessionId: string;
  parentCheckpointIds: string[];
  sessionHeadId: string | null;
  workspaceTreeOid: string;
  retentionCommitOid: string;
  reason: CheckpointReason;
  outcome?: "completed" | "aborted" | "failed";
  details?: {
    sourceRef?: string;
    restoreMode?: "workspace" | "context" | "both";
    contextStrategy?: "keep-current" | "summarize";
  };
  createdAt: number;
}

export interface BranchRef {
  sessionId: string;
  name: string;
  headCheckpointId: string;
  createdAt: number;
  updatedAt: number;
}

export interface BranchMove {
  sessionId: string;
  branchName: string;
  oldCheckpointId: string | null;
  newCheckpointId: string;
  reason: string;
  timestamp: number;
}

export interface BranchReflogEntry extends BranchMove {
  seq: number;
}

export interface Turn {
  id: string;
  sessionId: string;
  branchName: string;
  userEntryId: string;
  baseCheckpointId: string;
  resultCheckpointId: string | null;
  outcome: "running" | "completed" | "aborted" | "failed";
  startedAt: number;
  finishedAt?: number;
}

export interface ThreadCommit {
  id: string;
  sessionId: string;
  checkpointId: string;
  message: string;
  createdAt: number;
}

export interface ContextCapsule {
  checkpointId: string;
  sourceSessionHeadId: string | null;
  trigger: "commit" | "diff" | "merge" | "manual";
  status: "ready" | "failed";
  content?: string;
  model?: string;
  promptVersion: string;
  error?: string;
  createdAt: number;
}

export interface UsageRecord {
  turnId: string;
  step: number;
  usage: Usage;
}

export type VersionRef =
  | { kind: "branch"; name: string; checkpointId: string }
  | { kind: "commit"; id: string; checkpointId: string }
  | { kind: "checkpoint"; id: string; checkpointId: string };

export type SessionLogEvent =
  | { type: "session_created"; session: ProjectSession }
  | { type: "entry_appended"; entry: SessionEntry; lane: string }
  | { type: "lane_moved"; lane: string; leafId: string | null }
  | { type: "record_appended"; record: DurableRecord }
  | { type: "checkpoint_created"; checkpoint: InternalCheckpoint }
  | { type: "turn_started" | "turn_finished"; turn: Turn }
  | { type: "branch_created"; branch: BranchRef }
  | { type: "branch_moved"; move: BranchMove }
  | { type: "current_branch_changed"; branch: string; updatedAt: number }
  | { type: "thread_commit_created"; commit: ThreadCommit };

export type SessionLogRecord =
  | ({ seq: number; timestamp: number } & SessionLogEvent)
  | { seq: number; timestamp: number; type: "batch"; events: SessionLogEvent[] };
