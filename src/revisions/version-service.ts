import path from "node:path";
import type {
  ThreadCommit,
  BranchRef,
  DurableRecord,
  InternalCheckpoint,
  SessionLogEvent,
  Turn,
  VersionRef,
} from "../domain.js";
import { createId } from "../utils/id.js";
import type { SessionService } from "../session/service.js";
import { SessionCorruptionError } from "../session/projection.js";
import type { SidecarWorkspaceStore, WorkspaceSnapshot } from "../workspace/sidecar-store.js";

export interface CreateCheckpointOptions {
  reason: InternalCheckpoint["reason"];
  parentCheckpointIds: string[];
  sessionHeadId: string | null;
  branchName?: string;
  outcome?: InternalCheckpoint["outcome"];
  details?: InternalCheckpoint["details"];
  extraEvents?: (seq: number, timestamp: number, checkpoint: InternalCheckpoint) => SessionLogEvent[];
}

export interface VersionStatus {
  sessionId: string;
  rootPath: string;
  currentBranch: string;
  headCheckpointId: string;
  workspaceTreeOid: string;
  sessionHeadId: string | null;
  branchCount: number;
  commitCount: number;
}

export class VersionService {
  readonly warnings: string[] = [];
  constructor(
    readonly session: SessionService,
    readonly workspace: SidecarWorkspaceStore,
  ) {}

  get projection() {
    return this.session.projection;
  }

  get currentBranch(): BranchRef {
    return this.projection.currentBranch;
  }

  get head(): InternalCheckpoint {
    const checkpoint = this.projection.checkpoints.get(this.currentBranch.headCheckpointId);
    if (!checkpoint) throw new SessionCorruptionError(`Missing HEAD checkpoint ${this.currentBranch.headCheckpointId}`);
    return checkpoint;
  }

  private get lastRetentionCommitOid(): string | undefined {
    let oid: string | undefined;
    for (const checkpoint of this.projection.checkpoints.values()) oid = checkpoint.retentionCommitOid;
    return oid;
  }

  get expectedKeepRef(): string | undefined {
    return this.lastRetentionCommitOid;
  }

  async initialize(rootPath: string): Promise<{ created: boolean; recoveredOperations: string[] }> {
    await this.workspace.initialize();
    if (!this.projection.session) {
      const snapshot = await this.workspace.capture();
      const now = Date.now();
      const checkpoint: InternalCheckpoint = {
        id: createId("checkpoint"),
        sessionId: this.session.store.sessionId,
        parentCheckpointIds: [],
        sessionHeadId: null,
        workspaceTreeOid: snapshot.treeOid,
        retentionCommitOid: snapshot.retentionCommitOid,
        reason: "genesis",
        createdAt: now,
      };
      const branch: BranchRef = {
        sessionId: this.session.store.sessionId,
        name: "main",
        headCheckpointId: checkpoint.id,
        createdAt: now,
        updatedAt: now,
      };
      await this.session.store.appendBatch(
        () => [
          {
            type: "session_created",
            session: {
              id: this.session.store.sessionId,
              rootPath: path.resolve(rootPath),
              currentBranch: "main",
              createdAt: now,
              updatedAt: now,
            },
          },
          { type: "checkpoint_created", checkpoint },
          { type: "branch_created", branch },
        ],
        { flush: true },
      );
      await this.workspace.updateKeepRef(snapshot.retentionCommitOid);
      await this.session.store.writeSessionManifest(rootPath);
      return { created: true, recoveredOperations: [] };
    }

    if (path.resolve(this.projection.session.rootPath) !== path.resolve(rootPath)) {
      throw new SessionCorruptionError(
        `Session root mismatch: log=${this.projection.session.rootPath}, current=${path.resolve(rootPath)}`,
      );
    }
    await this.reconcileKeepRef();
    const recoveredOperations = await this.recoverStartup();
    this.projection.assertIdleInvariant(this.projection.session.currentBranch);
    return { created: false, recoveredOperations };
  }

  private async reconcileKeepRef(): Promise<void> {
    const latest = this.lastRetentionCommitOid;
    if (!latest) return;
    await this.workspace.verifyObjectSet(
      [...this.projection.checkpoints.values()].map((checkpoint) => ({
        treeOid: checkpoint.workspaceTreeOid,
        retentionCommitOid: checkpoint.retentionCommitOid,
      })),
    );
    await this.workspace.verifySnapshot(this.latestCheckpoint().workspaceTreeOid, latest);
    if ((await this.workspace.readKeepRef()) !== latest) await this.workspace.updateKeepRef(latest);
  }

  private latestCheckpoint(): InternalCheckpoint {
    const checkpoints = [...this.projection.checkpoints.values()];
    const latest = checkpoints.at(-1);
    if (!latest) throw new SessionCorruptionError("Session has no checkpoints");
    return latest;
  }

  async recoverStartup(): Promise<string[]> {
    const open = this.projection.getOpenOperations();
    const counts = new Map<string, number>();
    for (const operation of open) counts.set(operation.lane, (counts.get(operation.lane) ?? 0) + 1);
    for (const [lane, count] of counts) {
      if (count > 1) throw new SessionCorruptionError(`Lane ${lane} has ${count} open operations`);
      if (lane !== this.currentBranch.name) {
        throw new SessionCorruptionError(`Inactive branch ${lane} has an open operation`);
      }
    }
    const snapshot = await this.workspace.capture(this.lastRetentionCommitOid);
    const drifted = snapshot.treeOid !== this.head.workspaceTreeOid;
    if (!drifted && open.length === 0) return [];

    const runningTurns = [...this.projection.turns.values()].filter(
      (turn) => turn.outcome === "running" && turn.branchName === this.currentBranch.name,
    );
    const recovered = open.map((operation) => operation.id);
    await this.persistCheckpoint(snapshot, {
      reason: "recovery",
      parentCheckpointIds: [this.head.id],
      sessionHeadId: this.projection.lanes.get(this.currentBranch.name) ?? null,
      outcome: open.length > 0 ? "failed" : undefined,
      extraEvents: (seq, timestamp, checkpoint) => {
        const events: SessionLogEvent[] = [];
        for (const turn of runningTurns) {
          events.push({
            type: "turn_finished",
            turn: {
              ...turn,
              resultCheckpointId: checkpoint.id,
              outcome: "failed",
              finishedAt: timestamp,
            },
          });
        }
        for (const operation of open) {
          const record: DurableRecord = {
            id: createId("record"),
            seq,
            timestamp,
            type: "operation_finished",
            lane: operation.lane,
            runId: operation.id,
            outcome: "failed",
            error: { code: "process_interrupted", message: "Recovered an interrupted operation without replay" },
          };
          events.push({ type: "record_appended", record });
        }
        return events;
      },
    });
    return recovered;
  }

  async captureTurnBase(): Promise<InternalCheckpoint> {
    this.requireIdle();
    const snapshot = await this.workspace.capture(this.lastRetentionCommitOid);
    return this.persistCheckpoint(snapshot, {
      reason: "turn_base",
      parentCheckpointIds: [this.head.id],
      sessionHeadId: this.projection.lanes.get(this.currentBranch.name) ?? null,
    });
  }

  async finishTurn(
    turn: Turn,
    operationId: string,
    outcome: "completed" | "aborted" | "failed",
    error?: Error,
  ): Promise<InternalCheckpoint> {
    const snapshot = await this.workspace.capture(this.lastRetentionCommitOid);
    return this.persistCheckpoint(snapshot, {
      reason: "turn_result",
      parentCheckpointIds: [this.head.id],
      sessionHeadId: this.projection.lanes.get(turn.branchName) ?? null,
      outcome,
      branchName: turn.branchName,
      extraEvents: (seq, timestamp, checkpoint) => {
        const finishedTurn: Turn = {
          ...turn,
          resultCheckpointId: checkpoint.id,
          outcome,
          finishedAt: timestamp,
        };
        const record: DurableRecord = {
          id: createId("record"),
          seq,
          timestamp,
          type: "operation_finished",
          lane: turn.branchName,
          runId: operationId,
          outcome,
          ...(error ? { error: { code: error.name || "error", message: error.message } } : {}),
        };
        return [
          { type: "turn_finished", turn: finishedTurn },
          { type: "record_appended", record },
        ];
      },
    });
  }

  async finishCompaction(operationId: string, branchName = this.currentBranch.name): Promise<InternalCheckpoint> {
    const branch = this.projection.branches.get(branchName);
    if (!branch) throw new Error(`Unknown thread branch: ${branchName}`);
    const operation = this.projection
      .getOpenOperations(branchName)
      .find((candidate) => candidate.id === operationId && candidate.intent.kind === "compaction");
    if (!operation) throw new Error(`Unknown open compaction operation: ${operationId}`);
    const snapshot = await this.workspace.capture(this.lastRetentionCommitOid);
    return this.persistCheckpoint(snapshot, {
      reason: "command",
      parentCheckpointIds: [branch.headCheckpointId],
      sessionHeadId: this.projection.lanes.get(branchName) ?? null,
      branchName,
      extraEvents: (seq, timestamp) => [
        {
          type: "record_appended",
          record: {
            id: createId("record"),
            seq,
            timestamp,
            type: "operation_finished",
            lane: branchName,
            runId: operationId,
            outcome: "completed",
          },
        },
      ],
    });
  }

  async syncCurrentWorkspace(reason: "command" | "safety" = "command", always = false): Promise<InternalCheckpoint> {
    this.requireIdle();
    const snapshot = await this.workspace.capture(this.lastRetentionCommitOid);
    if (!always && snapshot.treeOid === this.head.workspaceTreeOid) return this.head;
    return this.persistCheckpoint(snapshot, {
      reason,
      parentCheckpointIds: [this.head.id],
      sessionHeadId: this.projection.lanes.get(this.currentBranch.name) ?? null,
    });
  }

  async persistCheckpoint(snapshot: WorkspaceSnapshot, options: CreateCheckpointOptions): Promise<InternalCheckpoint> {
    const branchName = options.branchName ?? this.currentBranch.name;
    const branch = this.projection.branches.get(branchName);
    if (!branch) throw new Error(`Unknown thread branch: ${branchName}`);
    const now = Date.now();
    const checkpoint: InternalCheckpoint = {
      id: createId("checkpoint"),
      sessionId: this.session.store.sessionId,
      parentCheckpointIds: [...options.parentCheckpointIds],
      sessionHeadId: options.sessionHeadId,
      workspaceTreeOid: snapshot.treeOid,
      retentionCommitOid: snapshot.retentionCommitOid,
      reason: options.reason,
      ...(options.outcome ? { outcome: options.outcome } : {}),
      ...(options.details ? { details: options.details } : {}),
      createdAt: now,
    };
    await this.session.store.appendBatch(
      (seq, timestamp) => [
        { type: "checkpoint_created", checkpoint },
        {
          type: "branch_moved",
          move: {
            sessionId: this.session.store.sessionId,
            branchName,
            oldCheckpointId: branch.headCheckpointId,
            newCheckpointId: checkpoint.id,
            reason: options.reason,
            timestamp,
          },
        },
        { type: "lane_moved", lane: branchName, leafId: options.sessionHeadId },
        ...(options.extraEvents?.(seq, timestamp, checkpoint) ?? []),
      ],
      { flush: true },
    );
    try {
      await this.workspace.updateKeepRef(snapshot.retentionCommitOid);
    } catch (error) {
      this.warnings.push(
        `Checkpoint ${checkpoint.id} is durable but the keep ref update is pending reconciliation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return checkpoint;
  }

  async createBranch(name: string, from = "HEAD", switchTo = true): Promise<BranchRef> {
    this.requireIdle();
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) || name === "HEAD" || name.includes("..")) {
      throw new Error(`Invalid thread branch name: ${name}`);
    }
    if (this.projection.branches.has(name)) throw new Error(`Thread branch already exists: ${name}`);
    await this.syncCurrentWorkspace("command");
    const target = this.resolve(from);
    const now = Date.now();
    const branch: BranchRef = {
      sessionId: this.session.store.sessionId,
      name,
      headCheckpointId: target.checkpointId,
      createdAt: now,
      updatedAt: now,
    };
    await this.session.store.append(() => ({ type: "branch_created", branch }), { flush: true });
    if (switchTo) await this.switchBranch(name);
    return branch;
  }

  async switchBranch(name: string): Promise<void> {
    this.requireIdle();
    if (name === this.currentBranch.name) return;
    const targetBranch = this.projection.branches.get(name);
    if (!targetBranch) throw new Error(`Unknown thread branch: ${name}`);
    await this.syncCurrentWorkspace("command");
    const current = this.head;
    const target = this.getCheckpoint(targetBranch.headCheckpointId);
    await this.workspace.restoreTree(current.workspaceTreeOid, target.workspaceTreeOid);
    await this.session.store.append(
      (_seq, timestamp) => ({ type: "current_branch_changed", branch: name, updatedAt: timestamp }),
      { flush: true },
    );
    this.projection.assertIdleInvariant(name);
  }

  async restore(ref: string, mode: "workspace" | "context" | "both" = "both"): Promise<InternalCheckpoint> {
    this.requireIdle();
    const targetRef = this.resolve(ref);
    const target = this.getCheckpoint(targetRef.checkpointId);
    const safety = await this.syncCurrentWorkspace("safety", true);
    if (mode === "both") {
      await this.workspace.restoreTree(safety.workspaceTreeOid, target.workspaceTreeOid);
      const branch = this.currentBranch;
      await this.session.store.appendBatch(
        (_seq, timestamp) => [
          {
            type: "branch_moved",
            move: {
              sessionId: this.session.store.sessionId,
              branchName: branch.name,
              oldCheckpointId: safety.id,
              newCheckpointId: target.id,
              reason: `restore:${ref}`,
              timestamp,
            },
          },
          { type: "lane_moved", lane: branch.name, leafId: target.sessionHeadId },
        ],
        { flush: true },
      );
      return target;
    }

    if (mode === "workspace") {
      await this.workspace.restoreTree(safety.workspaceTreeOid, target.workspaceTreeOid);
    }
    const combinedHead = mode === "context" ? target.sessionHeadId : safety.sessionHeadId;
    const snapshot = await this.workspace.capture(this.lastRetentionCommitOid);
    return this.persistCheckpoint(snapshot, {
      reason: "command",
      parentCheckpointIds: [safety.id],
      sessionHeadId: combinedHead,
      details: { sourceRef: ref, restoreMode: mode },
    });
  }

  async restoreTurnBefore(turnIdOrEntryId: string): Promise<InternalCheckpoint> {
    const candidates = [...this.projection.turns.values()].filter(
      (turn) =>
        turn.id === turnIdOrEntryId ||
        turn.userEntryId === turnIdOrEntryId ||
        turn.id.startsWith(turnIdOrEntryId) ||
        turn.userEntryId.startsWith(turnIdOrEntryId),
    );
    if (candidates.length !== 1) throw new Error(`Could not uniquely resolve turn: ${turnIdOrEntryId}`);
    return this.restore(candidates[0]!.baseCheckpointId, "both");
  }

  async createCommit(message: string): Promise<ThreadCommit> {
    if (!message.trim()) throw new Error("Thread commit message cannot be empty");
    await this.syncCurrentWorkspace("command");
    const commit: ThreadCommit = {
      id: createId("commit"),
      sessionId: this.session.store.sessionId,
      checkpointId: this.head.id,
      message: message.trim(),
      createdAt: Date.now(),
    };
    await this.session.store.append(() => ({ type: "thread_commit_created", commit }), { flush: true });
    return commit;
  }

  resolve(input: string): VersionRef {
    if (input === "HEAD") {
      return { kind: "branch", name: this.currentBranch.name, checkpointId: this.currentBranch.headCheckpointId };
    }
    const branch = this.projection.branches.get(input);
    if (branch) return { kind: "branch", name: branch.name, checkpointId: branch.headCheckpointId };
    const directCommit = this.projection.commits.get(input);
    if (directCommit) return { kind: "commit", id: directCommit.id, checkpointId: directCommit.checkpointId };
    const directCheckpoint = this.projection.checkpoints.get(input);
    if (directCheckpoint) return { kind: "checkpoint", id: directCheckpoint.id, checkpointId: directCheckpoint.id };
    const candidates: VersionRef[] = [];
    for (const commit of this.projection.commits.values()) {
      if (commit.id.startsWith(input)) candidates.push({ kind: "commit", id: commit.id, checkpointId: commit.checkpointId });
    }
    for (const checkpoint of this.projection.checkpoints.values()) {
      if (checkpoint.id.startsWith(input)) {
        candidates.push({ kind: "checkpoint", id: checkpoint.id, checkpointId: checkpoint.id });
      }
    }
    if (candidates.length === 0) throw new Error(`Unknown version ref: ${input}`);
    if (candidates.length > 1) throw new Error(`Ambiguous version ref: ${input}`);
    return candidates[0]!;
  }

  getCheckpoint(id: string): InternalCheckpoint {
    const checkpoint = this.projection.checkpoints.get(id);
    if (!checkpoint) throw new Error(`Unknown checkpoint: ${id}`);
    return checkpoint;
  }

  isAncestor(ancestorId: string, descendantId: string): boolean {
    const pending = [descendantId];
    const seen = new Set<string>();
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (id === ancestorId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...this.getCheckpoint(id).parentCheckpointIds);
    }
    return false;
  }

  bestCommonAncestor(leftId: string, rightId: string): string | null {
    const leftAncestors = this.ancestorSet(leftId);
    const rightAncestors = this.ancestorSet(rightId);
    const common = [...leftAncestors].filter((id) => rightAncestors.has(id));
    if (common.length === 0) return null;
    const best = common.filter(
      (candidate) => !common.some((other) => other !== candidate && this.isAncestor(candidate, other)),
    );
    if (best.length !== 1) {
      throw new Error(`Multiple best common ancestors are unsupported: ${best.join(", ")}`);
    }
    return best[0]!;
  }

  private ancestorSet(id: string): Set<string> {
    const result = new Set<string>();
    const pending = [id];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (result.has(current)) continue;
      result.add(current);
      pending.push(...this.getCheckpoint(current).parentCheckpointIds);
    }
    return result;
  }

  status(): VersionStatus {
    const checkpoint = this.head;
    return {
      sessionId: this.session.store.sessionId,
      rootPath: this.projection.session!.rootPath,
      currentBranch: this.currentBranch.name,
      headCheckpointId: checkpoint.id,
      workspaceTreeOid: checkpoint.workspaceTreeOid,
      sessionHeadId: checkpoint.sessionHeadId,
      branchCount: this.projection.branches.size,
      commitCount: this.projection.commits.size,
    };
  }

  requireIdle(): void {
    const open = this.projection.getOpenOperations();
    if (open.length > 0) throw new Error(`Project Session has an open operation: ${open[0]!.id}`);
    if (this.projection.session) this.projection.assertIdleInvariant(this.currentBranch.name);
  }
}
