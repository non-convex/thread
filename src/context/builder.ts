import type { Message } from "@earendil-works/pi-ai";
import type { CompactionEntry, RetainedTurn, SessionEntry } from "../session-tree/model.js";
import type { SessionTreeService } from "../session-tree/service.js";

export const COMPACTION_SUMMARY_PREFIX =
  "[The following is a memory and summary of earlier work]";

export interface BuiltContext {
  messages: Message[];
  compactableTurns: RetainedTurn[];
  latestCompaction?: CompactionEntry;
}

function summaryMessage(entry: CompactionEntry): Message {
  return {
    role: "user",
    content: `${COMPACTION_SUMMARY_PREFIX}\n\n${entry.summary}`,
    timestamp: entry.timestamp,
  };
}

function flattenTurns(turns: readonly RetainedTurn[]): Message[] {
  return turns.flatMap((turn) => structuredClone(turn.messages));
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
      return { messages: flattenTurns(compactableTurns), compactableTurns };
    }

    const latestCompaction = entries[compactionIndex] as CompactionEntry;
    const compactableTurns = structuredClone(latestCompaction.retainedTurns);
    appendEntryMessages(compactableTurns, entries.slice(compactionIndex + 1));
    return {
      messages: [summaryMessage(latestCompaction), ...flattenTurns(compactableTurns)],
      compactableTurns,
      latestCompaction: structuredClone(latestCompaction),
    };
  }
}
