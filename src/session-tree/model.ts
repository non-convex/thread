import type { Message } from "@earendil-works/pi-ai";

export const SESSION_TREE_FORMAT = "thread-session-tree-v1" as const;

export interface SessionTree {
  format: typeof SESSION_TREE_FORMAT;
  formatVersion: 1;
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
  workspaceStateId: string;
  status: TurnStatus;
  startedAt: number;
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
  replay: "safe" | "never";
}

export type SessionEntry = MessageEntry | ToolExecutionEntry;

export type SessionTreeEvent =
  | { type: "tree_created"; tree: SessionTree }
  | { type: "session_created"; session: ProjectSession }
  | { type: "active_session_changed"; sessionId: string; reason: "created" | "new" | "opened" }
  | { type: "turn_started"; turn: Turn }
  | { type: "entry_appended"; entry: SessionEntry }
  | { type: "turn_finished"; turnId: string; status: Exclude<TurnStatus, "running">; error?: { code: string; message: string }; finishedAt: number }
  | { type: "live_tip_changed"; sessionId: string; turnId: string | null; reason: "turn" | "rewind" };

export type SessionTreeRecord =
  | ({ sequence: number; timestamp: number } & SessionTreeEvent)
  | { sequence: number; timestamp: number; type: "batch"; events: SessionTreeEvent[] };
