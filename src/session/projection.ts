import type {
  ThreadCommit,
  BranchRef,
  BranchReflogEntry,
  DurableRecord,
  InternalCheckpoint,
  ProjectSession,
  SessionEntry,
  SessionLogEvent,
  SessionLogRecord,
  Turn,
} from "../domain.js";

// Sessions created by older builds can contain external-memory events. The
// subsystem is gone, but ignoring those records keeps the remaining versioned
// workspace and conversation history readable without rewriting the log.
interface LegacyMemoryChangedEvent {
  type: "memory_changed";
}

export class SessionCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCorruptionError";
  }
}

function assertUnused<T>(map: Map<string, T>, id: string, kind: string): void {
  if (map.has(id)) throw new SessionCorruptionError(`Duplicate ${kind} id: ${id}`);
}

export class SessionProjection {
  session: ProjectSession | undefined;
  readonly entries = new Map<string, SessionEntry>();
  readonly records: DurableRecord[] = [];
  readonly checkpoints = new Map<string, InternalCheckpoint>();
  readonly branches = new Map<string, BranchRef>();
  readonly lanes = new Map<string, string | null>();
  readonly turns = new Map<string, Turn>();
  readonly commits = new Map<string, ThreadCommit>();
  readonly reflog: BranchReflogEntry[] = [];
  nextSequence = 1;

  applyRecord(record: SessionLogRecord): void {
    if (record.seq !== this.nextSequence) {
      throw new SessionCorruptionError(`Expected log seq ${this.nextSequence}, got ${record.seq}`);
    }
    if (record.type === "batch") {
      for (const event of record.events) this.applyEvent(event, record.seq);
    } else {
      const { seq: _seq, timestamp: _timestamp, ...event } = record;
      this.applyEvent(event as SessionLogEvent, record.seq);
    }
    this.nextSequence++;
  }

  private applyEvent(event: SessionLogEvent | LegacyMemoryChangedEvent, seq: number): void {
    switch (event.type) {
      case "session_created": {
        if (this.session) throw new SessionCorruptionError("Session was created more than once");
        this.session = structuredClone(event.session);
        return;
      }
      case "entry_appended": {
        assertUnused(this.entries, event.entry.id, "entry");
        if (event.entry.parentId !== null && !this.entries.has(event.entry.parentId)) {
          throw new SessionCorruptionError(`Entry ${event.entry.id} has missing parent ${event.entry.parentId}`);
        }
        this.entries.set(event.entry.id, structuredClone(event.entry));
        this.lanes.set(event.lane, event.entry.id);
        return;
      }
      case "lane_moved": {
        if (event.leafId !== null && !this.entries.has(event.leafId)) {
          throw new SessionCorruptionError(`Lane ${event.lane} targets missing entry ${event.leafId}`);
        }
        this.lanes.set(event.lane, event.leafId);
        return;
      }
      case "record_appended": {
        if (this.records.some((record) => record.id === event.record.id)) {
          throw new SessionCorruptionError(`Duplicate record id: ${event.record.id}`);
        }
        this.records.push(structuredClone(event.record));
        return;
      }
      case "checkpoint_created": {
        assertUnused(this.checkpoints, event.checkpoint.id, "checkpoint");
        for (const parentId of event.checkpoint.parentCheckpointIds) {
          if (!this.checkpoints.has(parentId)) {
            throw new SessionCorruptionError(`Checkpoint ${event.checkpoint.id} has missing parent ${parentId}`);
          }
        }
        if (event.checkpoint.sessionHeadId !== null && !this.entries.has(event.checkpoint.sessionHeadId)) {
          throw new SessionCorruptionError(
            `Checkpoint ${event.checkpoint.id} has missing session head ${event.checkpoint.sessionHeadId}`,
          );
        }
        this.checkpoints.set(event.checkpoint.id, structuredClone(event.checkpoint));
        return;
      }
      case "turn_started":
      case "turn_finished": {
        if (!this.checkpoints.has(event.turn.baseCheckpointId)) {
          throw new SessionCorruptionError(`Turn ${event.turn.id} has missing base checkpoint`);
        }
        if (!this.entries.has(event.turn.userEntryId)) {
          throw new SessionCorruptionError(`Turn ${event.turn.id} has missing user entry`);
        }
        if (event.turn.resultCheckpointId !== null && !this.checkpoints.has(event.turn.resultCheckpointId)) {
          throw new SessionCorruptionError(`Turn ${event.turn.id} has missing result checkpoint`);
        }
        if (event.type === "turn_started") assertUnused(this.turns, event.turn.id, "turn");
        if (event.type === "turn_finished" && !this.turns.has(event.turn.id)) {
          throw new SessionCorruptionError(`Finished unknown turn ${event.turn.id}`);
        }
        this.turns.set(event.turn.id, structuredClone(event.turn));
        return;
      }
      case "branch_created": {
        if (this.branches.has(event.branch.name)) {
          throw new SessionCorruptionError(`Duplicate branch name: ${event.branch.name}`);
        }
        if (!this.checkpoints.has(event.branch.headCheckpointId)) {
          throw new SessionCorruptionError(`Branch ${event.branch.name} has missing checkpoint`);
        }
        this.branches.set(event.branch.name, structuredClone(event.branch));
        this.lanes.set(event.branch.name, this.checkpoints.get(event.branch.headCheckpointId)!.sessionHeadId);
        this.reflog.push({
          sessionId: event.branch.sessionId,
          seq,
          branchName: event.branch.name,
          oldCheckpointId: null,
          newCheckpointId: event.branch.headCheckpointId,
          reason: "branch_created",
          timestamp: event.branch.createdAt,
        });
        return;
      }
      case "branch_moved": {
        const branch = this.branches.get(event.move.branchName);
        if (!branch) throw new SessionCorruptionError(`Moved unknown branch ${event.move.branchName}`);
        if (branch.headCheckpointId !== event.move.oldCheckpointId) {
          throw new SessionCorruptionError(
            `Branch ${event.move.branchName} expected ${event.move.oldCheckpointId}, has ${branch.headCheckpointId}`,
          );
        }
        if (!this.checkpoints.has(event.move.newCheckpointId)) {
          throw new SessionCorruptionError(`Branch move targets missing checkpoint ${event.move.newCheckpointId}`);
        }
        branch.headCheckpointId = event.move.newCheckpointId;
        branch.updatedAt = event.move.timestamp;
        this.reflog.push({ ...structuredClone(event.move), seq });
        return;
      }
      case "current_branch_changed": {
        if (!this.session) throw new SessionCorruptionError("Current branch changed before session creation");
        if (!this.branches.has(event.branch)) throw new SessionCorruptionError(`Unknown current branch ${event.branch}`);
        this.session.currentBranch = event.branch;
        this.session.updatedAt = event.updatedAt;
        return;
      }
      case "thread_commit_created": {
        assertUnused(this.commits, event.commit.id, "commit");
        if (!this.checkpoints.has(event.commit.checkpointId)) {
          throw new SessionCorruptionError(`Commit ${event.commit.id} has missing checkpoint`);
        }
        this.commits.set(event.commit.id, structuredClone(event.commit));
        return;
      }
      case "memory_changed": {
        // Legacy compatibility only: external memory is no longer projected.
        return;
      }
    }
  }

  get currentBranch(): BranchRef {
    if (!this.session) throw new Error("Session has not been initialized");
    const branch = this.branches.get(this.session.currentBranch);
    if (!branch) throw new SessionCorruptionError(`Current branch ${this.session.currentBranch} is missing`);
    return branch;
  }

  getOpenOperations(lane?: string): Array<Extract<DurableRecord, { type: "operation_started" }>> {
    const finished = new Set(
      this.records
        .filter((record): record is Extract<DurableRecord, { type: "operation_finished" }> =>
          record.type === "operation_finished",
        )
        .map((record) => record.runId),
    );
    return this.records.filter(
      (record): record is Extract<DurableRecord, { type: "operation_started" }> =>
        record.type === "operation_started" && !finished.has(record.id) && (lane === undefined || record.lane === lane),
    );
  }

  assertIdleInvariant(branchName: string): void {
    const branch = this.branches.get(branchName);
    if (!branch) throw new SessionCorruptionError(`Unknown branch ${branchName}`);
    const checkpoint = this.checkpoints.get(branch.headCheckpointId);
    if (!checkpoint) throw new SessionCorruptionError(`Missing head checkpoint ${branch.headCheckpointId}`);
    if ((this.lanes.get(branchName) ?? null) !== checkpoint.sessionHeadId) {
      throw new SessionCorruptionError(`Lane ${branchName} does not match its branch checkpoint session head`);
    }
  }

  touch(timestamp = Date.now()): void {
    if (this.session) this.session.updatedAt = timestamp;
  }
}
