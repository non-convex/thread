import type { Message } from "@earendil-works/pi-ai";
import type {
  DurableRecord,
  SessionEntry,
  SessionLogEvent,
} from "../domain.js";
import { createId } from "../utils/id.js";
import { SessionCorruptionError } from "./projection.js";
import type { SessionLogStore } from "./log-store.js";

type NewEntry = SessionEntry extends infer T
  ? T extends SessionEntry
    ? Omit<T, "seq" | "parentId" | "timestamp">
    : never
  : never;

type NewRecord = DurableRecord extends infer T
  ? T extends DurableRecord
    ? Omit<T, "seq" | "timestamp">
    : never
  : never;

export interface BuiltSessionContext {
  messages: Message[];
  sourceEntryIds: string[];
  compactionEntryId: string | null;
}

export interface ContextDiffFacts {
  commonAncestorEntryId: string | null;
  fromOnly: { count: number; firstEntryId?: string; lastEntryId?: string };
  toOnly: { count: number; firstEntryId?: string; lastEntryId?: string };
  countsByType: Record<string, number>;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  compactionCount: number;
}

function contextMergeMessage(entry: Extract<SessionEntry, { type: "context_merge" }>): Message {
  return {
    role: "user",
    content: `[Context imported from thread branch ${entry.sourceRef}; source checkpoint ${entry.sourceCheckpointId}]\n${entry.content}`,
    timestamp: entry.timestamp,
  };
}

function compactionMessage(entry: Extract<SessionEntry, { type: "compaction" }>): Message {
  return {
    role: "user",
    content: `[Summary of earlier project-session context]\n${entry.summary}`,
    timestamp: entry.timestamp,
  };
}

export class SessionService {
  constructor(readonly store: SessionLogStore) {}

  get projection() {
    return this.store.projection;
  }

  async appendEntry(lane: string, entry: NewEntry, flush = false): Promise<SessionEntry> {
    let created: SessionEntry | undefined;
    await this.store.append(
      (seq, timestamp) => {
        const parentId = this.projection.lanes.get(lane) ?? null;
        created = { ...entry, seq, timestamp, parentId } as SessionEntry;
        return { type: "entry_appended", entry: created, lane };
      },
      { flush },
    );
    return structuredClone(created!);
  }

  async moveLane(lane: string, leafId: string | null, flush = false): Promise<void> {
    await this.store.append(() => ({ type: "lane_moved", lane, leafId }), { flush });
  }

  async appendRecord(record: NewRecord, flush = false): Promise<DurableRecord> {
    let created: DurableRecord | undefined;
    await this.store.append(
      (seq, timestamp) => {
        created = { ...record, seq, timestamp } as DurableRecord;
        return { type: "record_appended", record: created };
      },
      { flush },
    );
    return structuredClone(created!);
  }

  pathTo(headId: string | null): SessionEntry[] {
    const reversed: SessionEntry[] = [];
    const seen = new Set<string>();
    let id = headId;
    while (id !== null) {
      if (seen.has(id)) throw new SessionCorruptionError(`Cycle in session entry graph at ${id}`);
      seen.add(id);
      const entry = this.projection.entries.get(id);
      if (!entry) throw new SessionCorruptionError(`Missing session entry ${id}`);
      reversed.push(entry);
      id = entry.parentId;
    }
    return reversed.reverse();
  }

  buildContext(headId: string | null): BuiltSessionContext {
    const path = this.pathTo(headId);
    let compactionIndex = -1;
    for (let index = path.length - 1; index >= 0; index--) {
      if (path[index]!.type === "compaction") {
        compactionIndex = index;
        break;
      }
    }
    const messages: Message[] = [];
    const sourceEntryIds: string[] = [];
    if (compactionIndex >= 0) {
      const compaction = path[compactionIndex] as Extract<SessionEntry, { type: "compaction" }>;
      messages.push(compactionMessage(compaction), ...structuredClone(compaction.retainedTail));
      sourceEntryIds.push(compaction.id);
    }
    const start = compactionIndex + 1;
    for (let index = start; index < path.length; index++) {
      const entry = path[index]!;
      if (entry.type === "message") messages.push(structuredClone(entry.message));
      if (entry.type === "context_merge") messages.push(contextMergeMessage(entry));
      if (entry.type === "message" || entry.type === "context_merge") sourceEntryIds.push(entry.id);
    }
    return {
      messages,
      sourceEntryIds,
      compactionEntryId: compactionIndex >= 0 ? path[compactionIndex]!.id : null,
    };
  }

  contextDiff(fromHeadId: string | null, toHeadId: string | null): ContextDiffFacts {
    const fromPath = this.pathTo(fromHeadId);
    const toPath = this.pathTo(toHeadId);
    let commonLength = 0;
    while (
      commonLength < fromPath.length &&
      commonLength < toPath.length &&
      fromPath[commonLength]!.id === toPath[commonLength]!.id
    ) {
      commonLength++;
    }
    const fromOnlyEntries = fromPath.slice(commonLength);
    const toOnlyEntries = toPath.slice(commonLength);
    const divergent = [...fromOnlyEntries, ...toOnlyEntries];
    const countsByType: Record<string, number> = {};
    let userMessageCount = 0;
    let assistantMessageCount = 0;
    let toolCallCount = 0;
    let compactionCount = 0;
    for (const entry of divergent) {
      countsByType[entry.type] = (countsByType[entry.type] ?? 0) + 1;
      if (entry.type === "compaction") compactionCount++;
      if (entry.type !== "message") continue;
      if (entry.message.role === "user") userMessageCount++;
      if (entry.message.role === "assistant") {
        assistantMessageCount++;
        toolCallCount += entry.message.content.filter((content) => content.type === "toolCall").length;
      }
    }
    return {
      commonAncestorEntryId: commonLength > 0 ? fromPath[commonLength - 1]!.id : null,
      fromOnly: this.rangeFacts(fromOnlyEntries),
      toOnly: this.rangeFacts(toOnlyEntries),
      countsByType,
      userMessageCount,
      assistantMessageCount,
      toolCallCount,
      compactionCount,
    };
  }

  pagePath(headId: string | null, offset = 0, limit = 100): SessionEntry[] {
    if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("limit must be between 1 and 1000");
    return this.pathTo(headId).slice(offset, offset + limit).map((entry) => structuredClone(entry));
  }

  private rangeFacts(entries: SessionEntry[]): { count: number; firstEntryId?: string; lastEntryId?: string } {
    if (entries.length === 0) return { count: 0 };
    return { count: entries.length, firstEntryId: entries[0]!.id, lastEntryId: entries.at(-1)!.id };
  }

  async finishInterruptedOperations(): Promise<string[]> {
    const open = this.projection.getOpenOperations();
    const byLane = new Map<string, number>();
    for (const operation of open) byLane.set(operation.lane, (byLane.get(operation.lane) ?? 0) + 1);
    for (const [lane, count] of byLane) {
      if (count > 1) throw new SessionCorruptionError(`Lane ${lane} has ${count} open operations`);
    }
    const finished: string[] = [];
    for (const operation of open) {
      await this.appendRecord(
        {
          id: createId("record"),
          type: "operation_finished",
          lane: operation.lane,
          runId: operation.id,
          outcome: "failed",
          error: { code: "process_interrupted", message: "The previous process ended before this operation settled" },
        },
        true,
      );
      finished.push(operation.id);
    }
    return finished;
  }

  eventForEntry(lane: string, entry: SessionEntry): SessionLogEvent {
    return { type: "entry_appended", entry, lane };
  }
}
