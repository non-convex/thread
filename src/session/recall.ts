import type { Message } from "@earendil-works/pi-ai";
import type { SessionEntry, Turn } from "../domain.js";
import { createTurnPathClassifier, messageText, type TurnPathStatus } from "./history-status.js";
import type { SessionService } from "./service.js";

export interface RecallHit {
  turnId: string;
  matched: string[];
  score: number;
  status: TurnPathStatus;
  outcome: Turn["outcome"];
  branchName: string;
  startedAt: number;
  snippet: string;
}

export interface RecallResult {
  hits: RecallHit[];
  totals: Array<{ query: string; matches: number }>;
  totalMatchingTurns: number;
  searchedTurns: number;
}

export interface TurnDetail {
  turnId: string;
  status: TurnPathStatus;
  outcome: Turn["outcome"];
  branchName: string;
  startedAt: number;
  finishedAt: number | undefined;
  text: string;
  omitted: string[];
}

export interface ReadOptions {
  thinking?: boolean;
  toolCalls?: boolean;
  toolResults?: boolean;
}

interface MessageParts {
  narrative: string[];
  thinking: string[];
  toolCalls: string[];
  toolResults: string[];
}

/** Tracks which retained copies may stand in for an original; see `collectEntry`. */
interface RetainedCoverage {
  covered: Set<string>;
  claimed: Set<string>;
}

const SNIPPET_RADIUS = 90;
const MAX_ARGUMENT_CHARS = 200;
const MAX_RESULT_CHARS = 2_000;

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function collectMessage(message: Message, into: MessageParts): void {
  if (message.role === "user") {
    const text = messageText(message.content);
    if (text.length > 0) into.narrative.push(text);
    return;
  }
  if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type === "text" && block.text.length > 0) into.narrative.push(block.text);
      if (block.type === "thinking" && block.thinking.length > 0) into.thinking.push(block.thinking);
      if (block.type === "toolCall") {
        into.toolCalls.push(`${block.name} ${truncate(JSON.stringify(block.arguments ?? {}), MAX_ARGUMENT_CHARS)}`);
      }
    }
    return;
  }
  const text = messageText(message.content);
  into.toolResults.push(`${message.toolName}${message.isError ? " (error)" : ""}: ${truncate(text, MAX_RESULT_CHARS)}`);
}

function collectEntry(entry: SessionEntry, into: MessageParts, coverage: RetainedCoverage): void {
  if (entry.type === "message") {
    collectMessage(entry.message, into);
    return;
  }
  if (entry.type === "squash") {
    if (entry.summary.length > 0) into.narrative.push(entry.summary);
    /* A root squash re-roots the path and orphans the open turn's user entry, so a retained
     * copy may be that message's only surviving text. A copy whose original is still covered
     * by its own turn must be skipped, or the same text counts once per turn holding it. */
    for (const item of entry.retainedTail) {
      if (coverage.covered.has(item.sourceEntryId) || coverage.claimed.has(item.sourceEntryId)) continue;
      coverage.claimed.add(item.sourceEntryId);
      collectMessage(item.message, into);
    }
    return;
  }
  if (entry.type === "context_merge") into.narrative.push(entry.content);
}

/**
 * Tool output is searchable through neither path: it is bulky and re-readable from the
 * workspace. Thinking keeps its label so a snippet cannot pass reasoning off as something
 * the assistant actually said.
 */
function searchTextOf(parts: MessageParts): string {
  return [
    ...parts.narrative,
    ...parts.thinking.map((value) => `(thinking) ${value}`),
    ...parts.toolCalls,
  ].join("\n");
}

function snippetAround(text: string, needle: string): string {
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return text.slice(0, SNIPPET_RADIUS * 2).replace(/\s+/g, " ").trim();
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + needle.length + SNIPPET_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

/**
 * Searches the Session Tree by scanning the in-memory projection. A derived on-disk index
 * would buy nothing: the canonical log is already replayed into `projection` at startup, and
 * a substring scan has no minimum term length, query syntax or separate artifact to rebuild.
 */
export class SessionRecallService {
  constructor(private readonly session: SessionService) {}

  private classifier(): (turn: Turn) => TurnPathStatus {
    const tree = this.session.projection.tree;
    const headId = tree ? this.session.projection.lanes.get(tree.currentBranch) ?? null : null;
    return createTurnPathClassifier(this.session, headId);
  }

  /** Walks the turn's result head back to its user entry, covering aborted and failed turns too. */
  private turnEntries(turn: Turn): SessionEntry[] {
    const headId = turn.resultCheckpointId
      ? this.session.projection.checkpoints.get(turn.resultCheckpointId)?.sessionHeadId ?? null
      : null;
    const collected: SessionEntry[] = [];
    let id: string | null = headId ?? turn.userEntryId;
    while (id !== null) {
      const entry: SessionEntry | undefined = this.session.projection.entries.get(id);
      if (!entry) break;
      collected.push(entry);
      if (entry.id === turn.userEntryId) break;
      id = entry.parentId;
    }
    return collected.reverse();
  }

  /** Coverage spans every turn up front so a retained copy is attributed to exactly one turn. */
  private scanParts(turns: readonly Turn[]): Map<string, MessageParts> {
    const segments = turns.map((turn) => ({ turn, entries: this.turnEntries(turn) }));
    const coverage: RetainedCoverage = { covered: new Set(), claimed: new Set() };
    for (const { entries } of segments) for (const entry of entries) coverage.covered.add(entry.id);
    const result = new Map<string, MessageParts>();
    for (const { turn, entries } of segments) {
      const parts: MessageParts = { narrative: [], thinking: [], toolCalls: [], toolResults: [] };
      for (const entry of entries) collectEntry(entry, parts, coverage);
      result.set(turn.id, parts);
    }
    return result;
  }

  recall(queries: string[], limit: number): RecallResult {
    const terms = [...new Set(queries.map((query) => query.trim()).filter((query) => query.length > 0))];
    const allTurns = [...this.session.projection.turns.values()];
    const turns = allTurns.filter((turn) => turn.outcome !== "running");
    if (terms.length === 0) {
      return { hits: [], totals: [], totalMatchingTurns: 0, searchedTurns: turns.length };
    }
    const parts = this.scanParts(allTurns);
    const classify = this.classifier();

    const scanned = turns.map((turn) => {
      const text = searchTextOf(parts.get(turn.id)!);
      const haystack = text.toLowerCase();
      return { turn, text, matched: terms.filter((term) => haystack.includes(term.toLowerCase())) };
    });
    const totals = terms.map((query) => ({
      query,
      matches: scanned.filter((item) => item.matched.includes(query)).length,
    }));
    const documentFrequency = new Map(totals.map((total) => [total.query, total.matches]));
    const matching = scanned.filter((item) => item.matched.length > 0);

    const hits = matching
      .map((item) => {
        /* Summed IDF ranks a turn covering two concepts above one repeating a single synonym. */
        const score = item.matched.reduce((sum, term) => {
          const frequency = documentFrequency.get(term) ?? 0;
          return sum + Math.max(0, Math.log((scanned.length + 1) / (frequency + 1)));
        }, 0);
        const status = classify(item.turn);
        /* Proportional, never additive: a constant would swamp relevance and order by path.
         * Off-path is not penalised — a rewound branch is still memory. */
        const weight = status === "current-path" || status === "retained" ? 1.15 : 1;
        return {
          turnId: item.turn.id,
          matched: item.matched,
          score: score * weight,
          status,
          outcome: item.turn.outcome,
          branchName: item.turn.branchName,
          startedAt: item.turn.startedAt,
          snippet: snippetAround(item.text, item.matched[0]!),
        };
      })
      .sort((left, right) => right.score - left.score || right.startedAt - left.startedAt)
      .slice(0, limit);

    return { hits, totals, totalMatchingTurns: matching.length, searchedTurns: scanned.length };
  }

  /** Narrative is always returned; costlier sections are opt-in and otherwise named in `omitted`. */
  read(turnId: string, options: ReadOptions = {}): TurnDetail | undefined {
    const turn = this.session.projection.turns.get(turnId);
    if (!turn) return undefined;
    const parts = this.scanParts([turn]).get(turnId)!;
    const sections = [...parts.narrative];
    const omitted: string[] = [];
    const optional: Array<{ label: string; prefix: string; values: string[]; enabled: boolean | undefined }> = [
      { label: "thinking", prefix: "thinking", values: parts.thinking, enabled: options.thinking },
      { label: "toolCalls", prefix: "tool", values: parts.toolCalls, enabled: options.toolCalls },
      { label: "toolResults", prefix: "result", values: parts.toolResults, enabled: options.toolResults },
    ];
    for (const { label, prefix, values, enabled } of optional) {
      if (values.length === 0) continue;
      if (enabled) sections.push(...values.map((value) => `(${prefix}) ${value}`));
      else omitted.push(`${label}=${values.length}`);
    }
    return {
      turnId: turn.id,
      status: this.classifier()(turn),
      outcome: turn.outcome,
      branchName: turn.branchName,
      startedAt: turn.startedAt,
      finishedAt: turn.finishedAt,
      text: sections.join("\n"),
      omitted,
    };
  }
}
