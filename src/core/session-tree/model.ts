import type { Message } from "@earendil-works/pi-ai";
import type { DreamerAdmission, DreamerCheckpoint } from "../dreamer/state.js";

export const SESSION_TREE_FORMAT = "thread-session-tree-v2" as const;

export interface SessionTree {
  format: typeof SESSION_TREE_FORMAT;
  formatVersion: 2;
  id: string;
  projectId: string;
  rootId: string;
  rootPath: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSession {
  id: string;
  treeId: string;
  createdAt: number;
}

export type TurnStatus = "running" | "completed" | "interrupted" | "failed";

export interface Turn {
  id: string;
  sessionId: string;
  parentTurnId: string | null;
  userEntryId: string;
  status: TurnStatus;
  startedAt: number;
  /** Missing on legacy records, which captured file checkpoints by default. */
  fileCheckpoints?: boolean;
  dreamerReview?: DreamerAdmission;
  dreamerReviewedAt?: number;
  finishedAt?: number;
  error?: { code: string; message: string };
}

interface EntryBase {
  id: string;
  sessionId: string;
  turnId: string;
  ordinal: number;
  timestamp: number;
}

export interface MessageEntry extends EntryBase {
  type: "message";
  message: Message;
}

export interface ToolExecutionEntry extends EntryBase {
  type: "tool_execution";
  assistantEntryId: string;
  toolIndex: number;
  toolCallId: string;
  toolName: string;
  effectiveArgs: Record<string, unknown>;
}

export interface RetainedTurn {
  turnId: string;
  messages: Message[];
}

export interface FileEditEntry extends EntryBase {
  type: "file_edit";
  path: string;
  before: { blobId: string; mode: number } | null;
}

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface CompactionEntry extends EntryBase {
  type: "compaction";
  /** Cumulative cross-turn project-state document. */
  summary: string;
  /** Model-visible retained turns, starting from the retention cut point. */
  retainedTurns: RetainedTurn[];
  /** Optional in-turn progress summary when retention starts mid-turn. */
  progressSummary?: string;
  tokensBefore: number;
  tokensAfter: number;
  reason: CompactionReason;
}

export type SessionEntry = MessageEntry | ToolExecutionEntry | CompactionEntry | FileEditEntry;

/** Durable intent: replay file restoration before accepting more foreground work. */
export interface FileRewindIntent {
  sessionId: string;
  fromTurnId: string;
  toTurnId: string | null;
}

export type SessionTreeEvent =
  | { type: "tree_created"; tree: SessionTree }
  | { type: "session_created"; session: ProjectSession }
  | { type: "active_session_changed"; sessionId: string; reason: "created" | "new" | "opened" }
  | { type: "turn_started"; turn: Turn }
  | { type: "entry_appended"; entry: SessionEntry }
  | { type: "turn_finished"; turnId: string; status: Exclude<TurnStatus, "running">; error?: { code: string; message: string }; finishedAt: number }
  | { type: "dreamer_reviewed"; memoryPath: string; turnIds: string[]; checkpoint: DreamerCheckpoint }
  | { type: "live_tip_changed"; sessionId: string; turnId: string | null; reason: "turn" | "rewind" }
  | { type: "file_rewind_started"; rewind: FileRewindIntent }
  | { type: "file_rewind_finished"; sessionId: string };

export type SessionTreeRecord =
  | ({ sequence: number; timestamp: number } & SessionTreeEvent)
  | { sequence: number; timestamp: number; type: "batch"; events: SessionTreeEvent[] };
