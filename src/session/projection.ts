import type {
  ThreadCommit,
  BranchRef,
  BranchReflogEntry,
  DurableRecord,
  InternalCheckpoint,
  SessionTree,
  SessionEntry,
  SessionLogEvent,
  SessionLogRecord,
  Turn,
} from "../domain.js";

export class SessionCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionCorruptionError";
  }
}

function assertUnused<T>(map: Map<string, T>, id: string, kind: string): void {
  if (map.has(id)) throw new SessionCorruptionError(`Duplicate ${kind} id: ${id}`);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export class SessionProjection {
  tree: SessionTree | undefined;
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

  private applyEvent(event: SessionLogEvent, seq: number): void {
    if ((event as { type: string }).type === "session_created") {
      throw new SessionCorruptionError("Unsupported Session Tree format: 2 (legacy session_created event)");
    }
    switch (event.type) {
      case "tree_created": {
        if (this.tree) throw new SessionCorruptionError("Session Tree was created more than once");
        if (event.tree.formatVersion !== 3) {
          throw new SessionCorruptionError(
            `Unsupported Session Tree format: ${String(event.tree.formatVersion ?? "legacy")}`,
          );
        }
        this.tree = structuredClone(event.tree);
        return;
      }
      case "entry_appended": {
        assertUnused(this.entries, event.entry.id, "entry");
        if (!["message", "squash", "context_merge", "custom"].includes(event.entry.type)) {
          throw new SessionCorruptionError(`Unsupported session entry type: ${String(event.entry.type)}`);
        }
        if (event.entry.parentId !== null && !this.entries.has(event.entry.parentId)) {
          throw new SessionCorruptionError(`Entry ${event.entry.id} has missing parent ${event.entry.parentId}`);
        }
        if (this.tree && event.entry.sessionId !== this.tree.id) {
          throw new SessionCorruptionError(`Entry ${event.entry.id} belongs to another session`);
        }
        if (event.entry.type === "squash") {
          if (!["project_state", "incremental"].includes(event.entry.summaryKind)) {
            throw new SessionCorruptionError(`Squash ${event.entry.id} has an unsupported summary kind`);
          }
          if (typeof event.entry.summary !== "string") {
            throw new SessionCorruptionError(`Squash ${event.entry.id} has invalid summary content`);
          }
          if (!Number.isFinite(event.entry.requestTokensBefore) || event.entry.requestTokensBefore < 0) {
            throw new SessionCorruptionError(`Squash ${event.entry.id} has invalid request token metadata`);
          }
          if (!Array.isArray(event.entry.retainedTail)) {
            throw new SessionCorruptionError(`Squash ${event.entry.id} has an invalid retained tail`);
          }
          if (event.entry.summaryKind === "project_state" && event.entry.parentId !== null) {
            throw new SessionCorruptionError(`Project-state squash ${event.entry.id} must be an entry root`);
          }
          if (event.entry.summaryKind === "incremental" && event.entry.retainedTail.length > 0) {
            throw new SessionCorruptionError(`Incremental squash ${event.entry.id} cannot retain an inline tail`);
          }
          for (const retained of event.entry.retainedTail) {
            if (!retained || typeof retained.sourceEntryId !== "string" || !retained.message) {
              throw new SessionCorruptionError(`Squash ${event.entry.id} has an invalid retained message`);
            }
            const source = this.entries.get(retained.sourceEntryId);
            if (!source) {
              throw new SessionCorruptionError(
                `Squash ${event.entry.id} retained missing source entry ${retained.sourceEntryId}`,
              );
            }
            if (source.sessionId !== event.entry.sessionId) {
              throw new SessionCorruptionError(`Squash ${event.entry.id} retained an entry from another session`);
            }
          }
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
        if (
          event.record.type === "operation_started" &&
          !["run", "compaction"].includes(event.record.intent.kind)
        ) {
          throw new SessionCorruptionError(`Unsupported operation intent: ${String(event.record.intent.kind)}`);
        }
        if (event.record.type === "step_attempt") {
          if (!["assistant", "compaction"].includes(event.record.step)) {
            throw new SessionCorruptionError(`Unsupported step kind: ${String(event.record.step)}`);
          }
          if (
            event.record.compactionReason !== undefined &&
            !["compact_command", "threshold", "overflow"].includes(event.record.compactionReason)
          ) {
            throw new SessionCorruptionError(
              `Unsupported compaction reason: ${String(event.record.compactionReason)}`,
            );
          }
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
        if (event.checkpoint.reason === "squash") {
          if (event.checkpoint.parentCheckpointIds.length !== 1) {
            throw new SessionCorruptionError(`Squash checkpoint ${event.checkpoint.id} must have exactly one parent`);
          }
          const head = event.checkpoint.sessionHeadId
            ? this.entries.get(event.checkpoint.sessionHeadId)
            : undefined;
          if (head?.type !== "squash") {
            throw new SessionCorruptionError(`Squash checkpoint ${event.checkpoint.id} must target a squash entry`);
          }
          const parent = this.checkpoints.get(event.checkpoint.parentCheckpointIds[0]!);
          if (!parent) throw new SessionCorruptionError(`Squash checkpoint ${event.checkpoint.id} has no parent`);
          if (
            event.checkpoint.workspaceTreeOid !== parent.workspaceTreeOid ||
            event.checkpoint.retentionCommitOid !== parent.retentionCommitOid
          ) {
            throw new SessionCorruptionError(`Squash checkpoint ${event.checkpoint.id} changed workspace identity`);
          }
          const details = event.checkpoint.details;
          if (!details?.squashTrigger || !["compact_command", "thread_command", "threshold", "overflow"].includes(details.squashTrigger)) {
            throw new SessionCorruptionError(`Squash checkpoint ${event.checkpoint.id} has no trigger metadata`);
          }
          if (!hasOwn(details, "squashFromEntryId") || !hasOwn(details, "squashSourceHeadId")) {
            throw new SessionCorruptionError(`Squash checkpoint ${event.checkpoint.id} has incomplete source metadata`);
          }
          if (
            !Number.isInteger(details.squashEntryCount) || details.squashEntryCount! < 0 ||
            !Number.isInteger(details.squashTurnCount) || details.squashTurnCount! < 0
          ) {
            throw new SessionCorruptionError(`Squash checkpoint ${event.checkpoint.id} has invalid count metadata`);
          }
          if (details.squashSourceHeadId !== null && !this.entries.has(details.squashSourceHeadId!)) {
            throw new SessionCorruptionError(`Squash checkpoint ${event.checkpoint.id} has a missing source head`);
          }
          if (details.squashFromEntryId !== null) {
            const from = this.entries.get(details.squashFromEntryId!);
            if (from?.type !== "message" || from.message.role !== "user") {
              throw new SessionCorruptionError(`Squash checkpoint ${event.checkpoint.id} has an invalid user boundary`);
            }
          }
          if (details.squashTrigger === "thread_command") {
            if (head.summaryKind !== "incremental" || details.squashFromEntryId === null) {
              throw new SessionCorruptionError(`Thread squash checkpoint ${event.checkpoint.id} has inconsistent entry metadata`);
            }
          } else if (head.summaryKind !== "project_state" || details.squashFromEntryId !== null) {
            throw new SessionCorruptionError(`Root squash checkpoint ${event.checkpoint.id} has inconsistent entry metadata`);
          }
        }
        if (event.checkpoint.reason === "new") {
          if (event.checkpoint.parentCheckpointIds.length !== 1) {
            throw new SessionCorruptionError(`New-branch checkpoint ${event.checkpoint.id} must have one genesis parent`);
          }
          const parent = this.checkpoints.get(event.checkpoint.parentCheckpointIds[0]!);
          if (parent?.reason !== "genesis" || parent.parentCheckpointIds.length !== 0) {
            throw new SessionCorruptionError(`New-branch checkpoint ${event.checkpoint.id} must descend directly from genesis`);
          }
          if (event.checkpoint.sessionHeadId !== null) {
            throw new SessionCorruptionError(`New-branch checkpoint ${event.checkpoint.id} must start with empty context`);
          }
          const sourceId = event.checkpoint.details?.workspaceSourceCheckpointId;
          const source = sourceId ? this.checkpoints.get(sourceId) : undefined;
          if (!source) {
            throw new SessionCorruptionError(`New-branch checkpoint ${event.checkpoint.id} has no workspace source`);
          }
          if (
            event.checkpoint.workspaceTreeOid !== source.workspaceTreeOid ||
            event.checkpoint.retentionCommitOid !== source.retentionCommitOid
          ) {
            throw new SessionCorruptionError(`New-branch checkpoint ${event.checkpoint.id} changed its borrowed workspace identity`);
          }
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
        if (!this.tree) throw new SessionCorruptionError("Current branch changed before Session Tree creation");
        if (!this.branches.has(event.branch)) throw new SessionCorruptionError(`Unknown current branch ${event.branch}`);
        this.tree.currentBranch = event.branch;
        this.tree.updatedAt = event.updatedAt;
        return;
      }
      case "thread_commit_created": {
        assertUnused(this.commits, event.commit.id, "commit");
        const cost = event.commit.contextCost;
        if (!cost) {
          throw new SessionCorruptionError(`Commit ${event.commit.id} has no context cost metadata`);
        }
        if (
          !Number.isFinite(cost.percent) || cost.percent < 0 ||
          !Number.isFinite(cost.estimatedTokens) || cost.estimatedTokens < 0 ||
          !Number.isFinite(cost.contextWindow) || cost.contextWindow <= 0 ||
          !cost.providerId || !cost.modelId || !cost.estimatorVersion
        ) {
          throw new SessionCorruptionError(`Commit ${event.commit.id} has invalid context cost metadata`);
        }
        if (!this.checkpoints.has(event.commit.checkpointId)) {
          throw new SessionCorruptionError(`Commit ${event.commit.id} has missing checkpoint`);
        }
        this.commits.set(event.commit.id, structuredClone(event.commit));
        return;
      }
      default:
        throw new SessionCorruptionError(
          `Unsupported Session Tree event: ${String((event as { type?: unknown }).type ?? "missing")}`,
        );
    }
  }

  get currentBranch(): BranchRef {
    if (!this.tree) throw new Error("Session Tree has not been initialized");
    const branch = this.branches.get(this.tree.currentBranch);
    if (!branch) throw new SessionCorruptionError(`Current branch ${this.tree.currentBranch} is missing`);
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
    if (this.tree) this.tree.updatedAt = timestamp;
  }
}
