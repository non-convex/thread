import path from "node:path";
import type { Project } from "../project/model.js";
import { WorkspaceChangeApplier } from "./applier.js";
import { WorkspaceDiffer } from "./differ.js";
import { WorkspaceMaterializer } from "./materializer.js";
import { DEFAULT_WORKSPACE_EXCLUDED_DIRECTORY_NAMES } from "./policy.js";
import type {
  StagedWorkspaceState,
  WorkspaceChangeSet,
  WorkspaceScope,
  WorkspaceState,
  WorkspaceStatePolicy,
} from "./model.js";
import { WorkspaceSnapshotter } from "./snapshotter.js";
import { WorkspaceStateStore } from "./store.js";

function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

function normalizeExcludedPath(value: string): string {
  const normalized = slash(value).replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || path.isAbsolute(value) || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Workspace exclusion must be a project-relative path: ${value}`);
  }
  return normalized;
}

export interface WorkspaceStateRepositoryOptions {
  excludedPaths?: readonly string[];
}

/** Public façade over the independently reusable workspace-state components. */
export class WorkspaceStateRepository {
  readonly rootPath: string;
  readonly policy: WorkspaceStatePolicy;
  readonly store: WorkspaceStateStore;
  readonly snapshotter: WorkspaceSnapshotter;
  readonly materializer: WorkspaceMaterializer;
  readonly differ: WorkspaceDiffer;
  readonly applier: WorkspaceChangeApplier;

  constructor(readonly project: Project, options: WorkspaceStateRepositoryOptions = {}) {
    this.rootPath = project.rootPath;
    const excluded = new Set([".git", ".thread", ...(options.excludedPaths ?? []).map(normalizeExcludedPath)]);
    const relativeStatePath = slash(path.relative(project.rootPath, project.statePath));
    if (relativeStatePath && !relativeStatePath.startsWith("../") && relativeStatePath !== "..") excluded.add(relativeStatePath);
    this.policy = {
      excludedPaths: [...excluded].sort(),
      excludedDirectoryNames: [...DEFAULT_WORKSPACE_EXCLUDED_DIRECTORY_NAMES],
      includeIgnoredFiles: true,
      includeProjectMetadata: false,
    };
    this.store = new WorkspaceStateStore(project, this.policy);
    this.snapshotter = new WorkspaceSnapshotter(this.store);
    this.materializer = new WorkspaceMaterializer(this.store);
    this.differ = new WorkspaceDiffer();
    this.applier = new WorkspaceChangeApplier(this.rootPath, this.store, this.snapshotter, this.materializer);
  }

  get statesPath(): string { return this.store.statesPath; }
  get blobsPath(): string { return this.store.blobsPath; }
  get policyPath(): string { return this.store.policyPath; }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.applier.recover();
  }
  capture(): Promise<WorkspaceState> { return this.snapshotter.capture(this.rootPath); }
  captureStaged(): Promise<StagedWorkspaceState> { return this.snapshotter.captureStaged(this.rootPath); }
  captureFrom(rootPath: string): Promise<WorkspaceState> { return this.snapshotter.capture(rootPath); }
  captureStagedFrom(rootPath: string): Promise<StagedWorkspaceState> { return this.snapshotter.captureStaged(rootPath); }
  read(stateId: string): Promise<WorkspaceState> { return this.store.read(stateId); }
  verify(stateId: string): Promise<void> { return this.store.verify(stateId); }
  restore(stateId: string): Promise<void> { return this.materializer.materialize(stateId, this.rootPath); }
  materialize(stateId: string, targetRoot: string): Promise<void> { return this.materializer.materialize(stateId, targetRoot); }

  async createChangeSet(
    taskId: string,
    baseStateId: string,
    resultStateId: string,
    scopes: readonly WorkspaceScope[],
  ): Promise<WorkspaceChangeSet> {
    const [base, result] = await Promise.all([this.store.read(baseStateId), this.store.read(resultStateId)]);
    return this.differ.createChangeSet(taskId, base, result, scopes);
  }

  applyChangeSet(changeSet: WorkspaceChangeSet) { return this.applier.apply(changeSet); }

  async reviewDiff(changeSet: WorkspaceChangeSet, pathFilter?: string): Promise<string> {
    const operations = pathFilter ? changeSet.operations.filter((operation) => operation.path === pathFilter) : changeSet.operations;
    const sections: string[] = [];
    for (const operation of operations) {
      const before = operation.kind === "create" ? undefined : operation.before;
      const after = operation.kind === "delete" ? undefined : operation.after;
      const lines = [`diff --thread a/${operation.path} b/${operation.path}`, `operation: ${operation.kind}`];
      if (before?.kind === "file" || after?.kind === "file") {
        lines.push(`--- ${before ? `a/${operation.path}` : "/dev/null"}`);
        lines.push(`+++ ${after ? `b/${operation.path}` : "/dev/null"}`);
        lines.push(await this.fileProjection(before?.kind === "file" ? before.blobId : undefined, "-"));
        lines.push(await this.fileProjection(after?.kind === "file" ? after.blobId : undefined, "+"));
      } else {
        if (before) lines.push(`- ${JSON.stringify(before)}`);
        if (after) lines.push(`+ ${JSON.stringify(after)}`);
      }
      sections.push(lines.join("\n"));
    }
    return sections.join("\n\n") || "(no changes)";
  }
  garbageCollect(referencedStateIds: ReadonlySet<string>): Promise<{ statesRemoved: number; blobsRemoved: number }> {
    return this.store.garbageCollect(referencedStateIds);
  }
  async deleteUnreferenced(referencedStateIds: ReadonlySet<string>): Promise<number> {
    return (await this.garbageCollect(referencedStateIds)).statesRemoved;
  }

  private async fileProjection(blobId: string | undefined, prefix: string): Promise<string> {
    if (!blobId) return "";
    const content = await this.store.readBlob(blobId);
    if (content.includes(0)) return `${prefix} [binary ${content.length} bytes, blob ${blobId}]`;
    return content.toString("utf8").split(/\r?\n/).map((line) => `${prefix}${line}`).join("\n");
  }
}
