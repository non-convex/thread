import type { Message } from "@earendil-works/pi-ai";
import type { MessageEntry, SessionEntry, Turn } from "./model.js";
import type { SessionTreeService } from "./service.js";

export type HistoryPathStatus = "current-path" | "current-session-off-path" | "other-session";

export interface SessionSearchHit {
  sessionId: string;
  turnId: string;
  startedAt: number;
  status: Turn["status"];
  pathStatus: HistoryPathStatus;
  matched: string[];
  snippet: string;
}

export interface SessionSearchResult {
  searchedTurns: number;
  totalMatchingTurns: number;
  totals: Array<{ query: string; matches: number }>;
  hits: SessionSearchHit[];
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

function blockText(message: Message, includeThinking: boolean, includeToolCalls: boolean): string[] {
  if (typeof message.content === "string") return [message.content];
  const values: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") values.push(block.text);
    if (block.type === "image") values.push("[image]");
    if (block.type === "thinking" && includeThinking) values.push(block.thinking);
    if (block.type === "toolCall" && includeToolCalls) {
      values.push(`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`);
    }
  }
  return values;
}

function entryText(entry: SessionEntry, all = true): string {
  if (entry.type === "tool_execution") {
    return all ? `[tool started ${entry.toolName}] ${JSON.stringify(entry.effectiveArgs)}` : "";
  }
  if (entry.type === "compaction") return "";
  return blockText(entry.message, all, all).join("\n");
}

function normalizeQueries(queries: readonly string[]): string[] {
  const normalized = queries.map((query) => query.trim()).filter(Boolean);
  if (normalized.length === 0) throw new Error("At least one non-empty search query is required");
  return [...new Set(normalized)];
}

export class SessionSearchService {
  constructor(private readonly tree: SessionTreeService) {}

  private pathStatus(turn: Turn): HistoryPathStatus {
    const activeSessionId = this.tree.activeSession.id;
    if (turn.sessionId !== activeSessionId) return "other-session";
    const currentIds = new Set(this.tree.livePath().map((item) => item.id));
    return currentIds.has(turn.id) ? "current-path" : "current-session-off-path";
  }

  search(queries: readonly string[], limit = 8): SessionSearchResult {
    const terms = normalizeQueries(queries);
    const lower = terms.map((query) => query.toLocaleLowerCase());
    const totals = terms.map((query) => ({ query, matches: 0 }));
    const matching: SessionSearchHit[] = [];
    const turns = [...this.tree.projection.turns.values()].sort((left, right) => right.startedAt - left.startedAt);
    for (const turn of turns) {
      const text = this.tree.entriesForTurn(turn.id).map((entry) => entryText(entry)).filter(Boolean).join("\n");
      const haystack = text.toLocaleLowerCase();
      const matched: string[] = [];
      for (let index = 0; index < lower.length; index++) {
        if (!haystack.includes(lower[index]!)) continue;
        matched.push(terms[index]!);
        totals[index]!.matches++;
      }
      if (matched.length === 0) continue;
      const firstIndex = Math.min(...matched.map((term) => haystack.indexOf(term.toLocaleLowerCase())).filter((value) => value >= 0));
      const start = Math.max(0, firstIndex - 100);
      const snippet = text.slice(start, start + 320).replace(/\s+/g, " ").trim();
      matching.push({
        sessionId: turn.sessionId,
        turnId: turn.id,
        startedAt: turn.startedAt,
        status: turn.status,
        pathStatus: this.pathStatus(turn),
        matched,
        snippet,
      });
    }
    return {
      searchedTurns: turns.length,
      totalMatchingTurns: matching.length,
      totals,
      hits: matching.slice(0, Math.max(1, Math.floor(limit))),
    };
  }

  read(turnIdOrPrefix: string, options: { thinking?: boolean; toolCalls?: boolean; toolResults?: boolean } = {}): SessionTurnDetail | undefined {
    const matches = [...this.tree.projection.turns.values()].filter((turn) =>
      turn.id === turnIdOrPrefix || turn.id.startsWith(turnIdOrPrefix)
    );
    if (matches.length === 0) return undefined;
    if (matches.length > 1) throw new Error(`Turn prefix is ambiguous: ${turnIdOrPrefix}`);
    const turn = matches[0]!;
    const lines: string[] = [];
    const omitted = new Set<string>();
    for (const entry of this.tree.entriesForTurn(turn.id)) {
      if (entry.type === "compaction") continue;
      if (entry.type === "tool_execution") {
        if (options.toolCalls) lines.push(`[tool call ${entry.toolName}] ${JSON.stringify(entry.effectiveArgs)}`);
        else omitted.add("tool calls");
        continue;
      }
      const message = (entry as MessageEntry).message;
      if (message.role === "toolResult") {
        if (options.toolResults) lines.push(`[tool result ${message.toolName}] ${blockText(message, false, false).join("\n")}`);
        else omitted.add("tool results");
        continue;
      }
      const texts = blockText(message, options.thinking ?? false, false);
      if (message.role === "assistant" && !options.thinking && Array.isArray(message.content) &&
          message.content.some((block) => block.type === "thinking")) omitted.add("thinking");
      if (message.role === "assistant" && !options.toolCalls && Array.isArray(message.content) &&
          message.content.some((block) => block.type === "toolCall")) omitted.add("tool calls");
      if (texts.length > 0) lines.push(`[${message.role}]\n${texts.join("\n")}`);
    }
    return {
      sessionId: turn.sessionId,
      turnId: turn.id,
      startedAt: turn.startedAt,
      ...(turn.finishedAt === undefined ? {} : { finishedAt: turn.finishedAt }),
      status: turn.status,
      pathStatus: this.pathStatus(turn),
      text: lines.join("\n\n"),
      omitted: [...omitted],
    };
  }

  readPath(
    turnIdOrPrefix: string,
    options: {
      before?: number;
      after?: number;
      thinking?: boolean;
      toolCalls?: boolean;
      toolResults?: boolean;
    } = {},
  ): SessionTurnDetail[] {
    const selected = this.read(turnIdOrPrefix, options);
    if (!selected) return [];
    const savedPath = this.tree.livePath(selected.sessionId);
    const savedIndex = savedPath.findIndex((turn) => turn.id === selected.turnId);
    const path = savedIndex >= 0 ? savedPath : this.tree.pathToTurn(selected.turnId);
    const index = path.findIndex((turn) => turn.id === selected.turnId);
    const before = Math.max(0, Math.min(10, Math.floor(options.before ?? 0)));
    const after = Math.max(0, Math.min(10, Math.floor(options.after ?? 0)));
    return path.slice(Math.max(0, index - before), index + after + 1)
      .map((turn) => this.read(turn.id, options))
      .filter((detail): detail is SessionTurnDetail => detail !== undefined);
  }
}
