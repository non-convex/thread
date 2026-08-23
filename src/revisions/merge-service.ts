import type { SemanticRunner } from "../agent/semantic-runner.js";
import type { InternalCheckpoint, ThreadCommit } from "../domain.js";
import type { SessionService } from "../session/service.js";
import { createId } from "../utils/id.js";
import type { WorkspaceFileDiff } from "../workspace/sidecar-store.js";
import type { CapsuleService } from "./capsule-service.js";
import type { VersionService } from "./version-service.js";

const MERGE_SYSTEM_PROMPT = `You are transferring useful working context from an incoming thread branch into the current branch. Given the common ancestor, current, and incoming context summaries, write only information from the incoming branch that the current branch does not already know and that is useful for continuing work. Preserve source uncertainty, decisions, validation, and unresolved issues. Do not issue commands and do not invent facts. Return concise free text.`;

export type ContextMergeStrategy = "keep-current" | "summarize";

export interface MergePreview {
  incomingLabel: string;
  currentBranch: string;
  currentCheckpointId: string;
  incomingCheckpointId: string;
  commonAncestorCheckpointId: string;
  clean: boolean;
  conflicts: string[];
  workspaceFiles: WorkspaceFileDiff[];
  treeOid?: string;
  createdAt: number;
}

export interface MergeResult {
  clean: boolean;
  conflicts: string[];
  checkpoint?: InternalCheckpoint;
  commit?: ThreadCommit;
  contextStrategy: ContextMergeStrategy;
}

export class MergeService {
  constructor(
    private readonly versions: VersionService,
    private readonly session: SessionService,
    private readonly capsules: CapsuleService,
    private readonly semantic?: SemanticRunner,
  ) {}

  async preview(incomingLabel: string): Promise<MergePreview> {
    this.versions.requireIdle();
    await this.versions.syncCurrentWorkspace("command");
    const incomingRef = this.versions.resolve(incomingLabel);
    const incoming = this.versions.getCheckpoint(incomingRef.checkpointId);
    const ours = this.versions.head;
    const baseId = this.versions.bestCommonAncestor(ours.id, incoming.id);
    if (!baseId) throw new Error("The versions have no common checkpoint ancestor");
    const base = this.versions.getCheckpoint(baseId);
    const plan = await this.versions.workspace.mergeTrees(
      base.workspaceTreeOid,
      ours.workspaceTreeOid,
      incoming.workspaceTreeOid,
    );
    const workspaceFiles = plan.clean && plan.treeOid
      ? await this.versions.workspace.diffTrees(ours.workspaceTreeOid, plan.treeOid)
      : [];
    return {
      incomingLabel,
      currentBranch: this.versions.currentBranch.name,
      currentCheckpointId: ours.id,
      incomingCheckpointId: incoming.id,
      commonAncestorCheckpointId: base.id,
      clean: plan.clean,
      conflicts: [...plan.conflicts],
      workspaceFiles,
      ...(plan.treeOid ? { treeOid: plan.treeOid } : {}),
      createdAt: Date.now(),
    };
  }

  async prepareContextNote(preview: MergePreview, signal: AbortSignal): Promise<string> {
    this.assertFresh(preview);
    if (!this.semantic) throw new Error("Context summarize merge requires a configured semantic model");
    const base = this.versions.getCheckpoint(preview.commonAncestorCheckpointId);
    const ours = this.versions.getCheckpoint(preview.currentCheckpointId);
    const incoming = this.versions.getCheckpoint(preview.incomingCheckpointId);
    const [baseCapsule, oursCapsule, incomingCapsule] = await Promise.all([
      this.capsules.getOrGenerate(base, "merge", signal),
      this.capsules.getOrGenerate(ours, "merge", signal),
      this.capsules.getOrGenerate(incoming, "merge", signal),
    ]);
    const ready = [baseCapsule, oursCapsule, incomingCapsule].every((capsule) => capsule.status === "ready");
    if (!ready) throw new Error("Could not generate all context capsules required for summarize merge");
    return this.semantic.run({
      systemPrompt: MERGE_SYSTEM_PROMPT,
      prompt: [
        `COMMON ANCESTOR\n${baseCapsule.content}`,
        `CURRENT BRANCH\n${oursCapsule.content}`,
        `INCOMING ${preview.incomingLabel}\n${incomingCapsule.content}`,
      ].join("\n\n"),
      maxTokens: 2_000,
      signal,
    });
  }

  async applyPreview(
    preview: MergePreview,
    strategy: ContextMergeStrategy,
    signal: AbortSignal,
    preparedNote?: string,
  ): Promise<MergeResult> {
    this.assertFresh(preview);
    if (!preview.clean || !preview.treeOid) {
      return { clean: false, conflicts: [...preview.conflicts], contextStrategy: strategy };
    }
    const incoming = this.versions.getCheckpoint(preview.incomingCheckpointId);
    const base = this.versions.getCheckpoint(preview.commonAncestorCheckpointId);
    const mergeNote = strategy === "summarize"
      ? preparedNote ?? await this.prepareContextNote(preview, signal)
      : undefined;
    signal.throwIfAborted();

    const safety = await this.versions.syncCurrentWorkspace("safety", true);
    let noteAppended = false;
    let workspaceApplied = false;
    let checkpoint: InternalCheckpoint | undefined;
    try {
      await this.versions.workspace.restoreTree(safety.workspaceTreeOid, preview.treeOid);
      workspaceApplied = true;
      if (mergeNote !== undefined) {
        await this.session.appendEntry(
          this.versions.currentBranch.name,
          {
            id: createId("entry"),
            sessionId: this.session.store.sessionId,
            type: "context_merge",
            sourceRef: preview.incomingLabel,
            sourceCheckpointId: incoming.id,
            commonAncestorCheckpointId: base.id,
            content: mergeNote,
          },
          true,
        );
        noteAppended = true;
      }
      const snapshot = await this.versions.workspace.retainTree(preview.treeOid, safety.retentionCommitOid);
      checkpoint = await this.versions.persistCheckpoint(snapshot, {
        reason: "merge",
        parentCheckpointIds: [safety.id, incoming.id],
        sessionHeadId: this.session.projection.lanes.get(this.versions.currentBranch.name) ?? null,
        details: { sourceRef: preview.incomingLabel, contextStrategy: strategy },
      });
    } catch (error) {
      if (!checkpoint) {
        if (workspaceApplied) {
          await this.versions.workspace.restoreTree(preview.treeOid, safety.workspaceTreeOid).catch(() => undefined);
        }
        if (noteAppended) {
          await this.session.moveLane(this.versions.currentBranch.name, safety.sessionHeadId, true).catch(() => undefined);
        }
      }
      throw error;
    }
    const commit = await this.versions.createCommit(`Merge thread version ${preview.incomingLabel}`);
    await this.capsules.generate(checkpoint, "merge", signal).catch(() => undefined);
    return { clean: true, conflicts: [], checkpoint, commit, contextStrategy: strategy };
  }

  async merge(incomingLabel: string, strategy: ContextMergeStrategy, signal: AbortSignal): Promise<MergeResult> {
    const preview = await this.preview(incomingLabel);
    const note = strategy === "summarize" && preview.clean
      ? await this.prepareContextNote(preview, signal)
      : undefined;
    return this.applyPreview(preview, strategy, signal, note);
  }

  private assertFresh(preview: MergePreview): void {
    this.versions.requireIdle();
    if (this.versions.currentBranch.name !== preview.currentBranch || this.versions.head.id !== preview.currentCheckpointId) {
      throw new Error("Merge preview is stale because the current thread branch moved; open a new preview");
    }
    const incoming = this.versions.resolve(preview.incomingLabel);
    if (incoming.checkpointId !== preview.incomingCheckpointId) {
      throw new Error("Merge preview is stale because the incoming thread version moved; open a new preview");
    }
  }
}
