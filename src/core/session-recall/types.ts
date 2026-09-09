import type { Turn } from "../session-tree/model.js";

export type HistoryPathStatus = "current-path" | "current-session-off-path" | "other-session";
export type RetrievalSource = "literal" | "keyword" | "semantic";
export type ContentKind = "user" | "assistant" | "thinking" | "tool-call" | "tool-result" | "image";

export interface RecallDocument {
  id: string;
  sessionId: string;
  turnId: string;
  entryId: string;
  kind: ContentKind;
  text: string;
  semantic: boolean;
}

export interface TextSpan { start: number; end: number; text: string }
export interface RecallFragment extends RecallDocument { start: number; end: number }
export interface EmbeddedFragment extends RecallFragment { vector: Float32Array }

export interface RecallSearchHit {
  sessionId: string;
  turnId: string;
  entryId: string;
  kind: ContentKind;
  startedAt: number;
  status: Turn["status"];
  pathStatus: HistoryPathStatus;
  queries: string[];
  sources: RetrievalSource[];
  snippet: string;
}

export interface RecallSearchResult {
  coverage: { totalTurns: number; keywordTurns: number; semanticTurns: number };
  semantic: "disabled" | "preparing" | "indexing" | "ready" | "unavailable";
  diagnostics: string[];
  hits: RecallSearchHit[];
}

export interface ReadOptions {
  thinking?: boolean;
  toolCalls?: boolean;
  toolResults?: boolean;
  before?: number;
  after?: number;
}

export interface SessionTurnDetail {
  sessionId: string;
  turnId: string;
  startedAt: number;
  finishedAt?: number;
  status: Turn["status"];
  pathStatus: HistoryPathStatus;
  text: string;
  omitted: string[];
}
