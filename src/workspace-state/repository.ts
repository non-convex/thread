import path from "node:path";
import type { Project } from "../project/model.js";
import { WorkspaceMaterializer } from "./materializer.js";
import type { StagedWorkspaceState, WorkspaceState, WorkspaceStatePolicy } from "./model.js";
import { DEFAULT_WORKSPACE_EXCLUDED_DIRECTORY_NAMES } from "./policy.js";
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

/** Public façade over checkpoint capture, restore, verification, and garbage collection. */
export class WorkspaceStateRepository {
  readonly rootPath: string;
  readonly policy: WorkspaceStatePolicy;
  readonly store: WorkspaceStateStore;
  readonly snapshotter: WorkspaceSnapshotter;
  readonly materializer: WorkspaceMaterializer;

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
  }

  get statesPath(): string { return this.store.statesPath; }
  get blobsPath(): string { return this.store.blobsPath; }
  get policyPath(): string { return this.store.policyPath; }

  initialize(): Promise<void> { return this.store.initialize(); }
  capture(): Promise<WorkspaceState> { return this.snapshotter.capture(this.rootPath); }
  captureStaged(): Promise<StagedWorkspaceState> { return this.snapshotter.captureStaged(this.rootPath); }
  read(stateId: string): Promise<WorkspaceState> { return this.store.read(stateId); }
  verify(stateId: string): Promise<void> { return this.store.verify(stateId); }
  restore(stateId: string): Promise<void> { return this.materializer.materialize(stateId, this.rootPath); }
  garbageCollect(referencedStateIds: ReadonlySet<string>): Promise<{ statesRemoved: number; blobsRemoved: number }> {
    return this.store.garbageCollect(referencedStateIds);
  }
  async deleteUnreferenced(referencedStateIds: ReadonlySet<string>): Promise<number> {
    return (await this.garbageCollect(referencedStateIds)).statesRemoved;
  }
}
