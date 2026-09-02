import type { Message } from "@earendil-works/pi-ai";
import type { CompactionEntry, RetainedTurn, SessionEntry } from "../session-tree/model.js";
import type { SessionTreeService } from "../session-tree/service.js";

export const COMPACTION_SUMMARY_PREFIX =
  "[The following is a memory and summary of earlier work]";

export const TURN_PROGRESS_PREFIX =
  "[The following is a continuation checkpoint for an earlier portion of this turn]";

export interface BuiltContext {
  messages: Message[];
  compactableTurns: RetainedTurn[];
  latestCompaction?: CompactionEntry;
}

export function historySummaryMessage(summary: string, timestamp: number): Message {
  return {
    role: "user",
    content: `${COMPACTION_SUMMARY_PREFIX}\n\n${summary}`,
    timestamp,
  };
}

export function progressSummaryMessage(summary: string, timestamp: number): Message {
  return {
    role: "user",
    content: [
      TURN_PROGRESS_PREFIX,
      "The original request for this turn is preserved verbatim immediately above. Its earlier raw messages remain available through session_read.",
      "The most recent complete assistant/tool steps follow this checkpoint verbatim.",
      "Continue the task directly without acknowledging this checkpoint or asking the user to repeat the request.",
      "",
      summary,
    ].join("\n"),
    timestamp,
  };
}

export function flattenTurnProjections(turns: readonly RetainedTurn[]): Message[] {
  return turns.flatMap((turn) => turn.messages.map((message) => structuredClone(message)));
}

/**
 * The single definition of a compacted live context. Compaction measures its
 * result through this function and the builder replays it on every request, so
 * the verified token count and the eventual prompt cannot drift apart.
 *
 * Order: history document, then the partially retained turn's copied request,
 * then its progress checkpoint, then every retained message verbatim.
 */
export function projectedContextMessages(
  summary: string,
  turns: readonly RetainedTurn[],
  timestamp: number,
  progressSummary?: string,
): Message[] {
  const messages: Message[] = [];
  if (summary.trim()) messages.push(historySummaryMessage(summary, timestamp));

  const flattened = flattenTurnProjections(turns);
  if (!progressSummary?.trim() || flattened.length === 0) {
    messages.push(...flattened);
    return messages;
  }

  // The checkpoint belongs between the copied request and the retained steps.
  messages.push(flattened[0]!, progressSummaryMessage(progressSummary, timestamp), ...flattened.slice(1));
  return messages;
}

function appendEntryMessages(turns: RetainedTurn[], entries: readonly SessionEntry[]): void {
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const last = turns[turns.length - 1];
    if (!last || last.turnId !== entry.turnId) {
      turns.push({ turnId: entry.turnId, messages: [structuredClone(entry.message)] });
    } else {
      last.messages.push(structuredClone(entry.message));
    }
  }
}

/**
 * Live context is rebuilt from the current Session Tree path on every request.
 * The newest compaction entry replaces only the entries before it; the original
 * entries remain in the tree for rewind, branching, history, and search.
 */
export class ContextBuilder {
  constructor(private readonly tree: SessionTreeService) {}

  build(tipTurnId?: string): BuiltContext {
    const turns = tipTurnId ? this.tree.pathToTurn(tipTurnId) : this.tree.livePath();
    const entries = turns.flatMap((turn) => this.tree.entriesForTurn(turn.id));
    let compactionIndex = -1;
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index]!.type === "compaction") {
        compactionIndex = index;
        break;
      }
    }

    if (compactionIndex < 0) {
      const compactableTurns: RetainedTurn[] = [];
      appendEntryMessages(compactableTurns, entries);
      return { messages: flattenTurnProjections(compactableTurns), compactableTurns };
    }

    const latestCompaction = entries[compactionIndex] as CompactionEntry;
    const compactableTurns = latestCompaction.retainedTurns.map((turn) => structuredClone(turn));
    appendEntryMessages(compactableTurns, entries.slice(compactionIndex + 1));
    return {
      messages: projectedContextMessages(
        latestCompaction.summary,
        compactableTurns,
        latestCompaction.timestamp,
        latestCompaction.progressSummary,
      ),
      compactableTurns,
      latestCompaction: structuredClone(latestCompaction),
    };
  }
}
