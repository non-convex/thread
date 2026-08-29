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

export interface MessageOrigin {
  entryId: string;
  kind: "entry" | "retained";
  containerEntryId?: string;
  retainedIndex?: number;
}

type NewRecord = DurableRecord extends infer T
  ? T extends DurableRecord
    ? Omit<T, "seq" | "timestamp">
    : never
  : never;

export interface BuiltSessionContext {
  messages: Message[];
  origins: MessageOrigin[];
  rootProjectState?: { entryId: string; summary: string };
}

export interface ContextDiffFacts {
  commonAncestorEntryId: string | null;
  fromOnly: { count: number; firstEntryId?: string; lastEntryId?: string };
  toOnly: { count: number; firstEntryId?: string; lastEntryId?: string };
  countsByType: Record<string, number>;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  squashCount: number;
}

function contextMergeMessage(entry: Extract<SessionEntry, { type: "context_merge" }>): Message {
  return {
    role: "user",
    content: `[Context imported from thread branch ${entry.sourceRef}; source checkpoint ${entry.sourceCheckpointId}]\n${entry.content}`,
    timestamp: entry.timestamp,
  };
}

/**
 * The squash entry as the model sees it: the narrative summary only. Workspace
 * facts are deliberately absent — the agent verifies those against the live
 * workspace and the sidecar when it needs them, rather than carrying a snapshot
 * of file churn in the prefix of every later turn.
 */
export function squashMessage(entry: Extract<SessionEntry, { type: "squash" }>): Message {
  const heading = entry.summaryKind === "project_state"
    ? "[Summary of earlier project-session context]"
    : "[Session history squashed from the selected user turn; workspace preserved]";
  return {
    role: "user",
    content: [heading, entry.summary].join("\n"),
    timestamp: entry.timestamp,
  };
}

export class SessionService {
  constructor(readonly store: SessionLogStore) {}

  get projection() {
    return this.store.projection;
  }

  async appendEntry(lane: string, entry: NewEntry, flush = false): Promise<SessionEntry> {
    const leaf = this.projection.lanes.get(lane) ?? null;
    return this.appendEntryAt(lane, leaf, entry, { expectedLeafId: leaf, flush });
  }

  async appendEntryAt(
    lane: string,
    parentId: string | null,
    entry: NewEntry,
    options: { expectedLeafId: string | null; flush?: boolean; entryTimestamp?: number },
  ): Promise<SessionEntry> {
    let created: SessionEntry | undefined;
    await this.store.append(
      (seq, timestamp) => {
        const currentLeaf = this.projection.lanes.get(lane) ?? null;
        if (currentLeaf !== options.expectedLeafId) {
          throw new Error(
            `Session lane ${lane} moved while planning an entry: expected ${options.expectedLeafId ?? "null"}, has ${currentLeaf ?? "null"}`,
          );
        }
        if (parentId !== null) {
          const parent = this.projection.entries.get(parentId);
          if (!parent) throw new Error(`Cannot append entry at missing parent ${parentId}`);
          if (parent.sessionId !== entry.sessionId) {
            throw new Error(`Cannot append entry to a parent from another session: ${parentId}`);
          }
          if (parent.id === entry.id) throw new Error(`Entry ${entry.id} cannot be its own parent`);
        }
        if (this.projection.entries.has(entry.id)) throw new Error(`Duplicate entry id: ${entry.id}`);
        if (entry.type === "squash") {
          for (const retained of entry.retainedTail) {
            const source = this.projection.entries.get(retained.sourceEntryId);
            if (!source) throw new Error(`Squash retained tail references missing entry ${retained.sourceEntryId}`);
            if (source.sessionId !== entry.sessionId) {
              throw new Error(`Squash retained tail references another session: ${retained.sourceEntryId}`);
            }
          }
        }
        created = { ...entry, seq, timestamp: options.entryTimestamp ?? timestamp, parentId } as SessionEntry;
        return { type: "entry_appended", entry: created, lane };
      },
      options.flush === undefined ? {} : { flush: options.flush },
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
    const messages: Message[] = [];
    const origins: MessageOrigin[] = [];
    let rootProjectState: BuiltSessionContext["rootProjectState"];
    for (let index = 0; index < path.length; index++) {
      const entry = path[index]!;
      if (entry.type === "message") {
        messages.push(structuredClone(entry.message));
        origins.push({ entryId: entry.id, kind: "entry" });
      }
      if (entry.type === "context_merge") {
        messages.push(contextMergeMessage(entry));
        origins.push({ entryId: entry.id, kind: "entry" });
      }
      if (entry.type === "squash") {
        messages.push(squashMessage(entry));
        origins.push({ entryId: entry.id, kind: "entry" });
        if (entry.summaryKind === "project_state" && messages.length === 1) {
          rootProjectState = { entryId: entry.id, summary: entry.summary };
        }
        for (let retainedIndex = 0; retainedIndex < entry.retainedTail.length; retainedIndex++) {
          const retained = entry.retainedTail[retainedIndex]!;
          messages.push(structuredClone(retained.message));
          origins.push({
            entryId: retained.sourceEntryId,
            kind: "retained",
            containerEntryId: entry.id,
            retainedIndex,
          });
        }
      }
    }
    if (messages.length !== origins.length) throw new SessionCorruptionError("Context messages and origins diverged");
    return { messages, origins, ...(rootProjectState ? { rootProjectState } : {}) };
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
    let squashCount = 0;
    for (const entry of divergent) {
      countsByType[entry.type] = (countsByType[entry.type] ?? 0) + 1;
      if (entry.type === "squash") squashCount++;
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
      squashCount,
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
