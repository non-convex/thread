import path from "node:path";
import type {
  StagedWorkspaceState,
  WorkspaceChangeSet,
  WorkspaceScope,
  WorkspaceState,
} from "./model.js";
import type { WorkspaceStateRepository } from "./repository.js";

export interface WorkspaceCheckpoint {
  stateId: string;
  persisted: Promise<unknown>;
}

export class WorkspaceStateService {
  private latest: WorkspaceCheckpoint | undefined;

  constructor(readonly repository: WorkspaceStateRepository) {}

  async baseline(): Promise<WorkspaceCheckpoint> {
    return this.latest ?? this.record(await this.repository.captureStaged());
  }

  async checkpoint(): Promise<void> {
    try {
      this.record(await this.repository.captureStaged());
    } catch {
      // Keep the last successful checkpoint if this scan fails.
    }
  }

  referencedStateIds(): string[] {
    return this.latest ? [this.latest.stateId] : [];
  }

  async settle(): Promise<void> {
    await this.latest?.persisted.then(() => undefined, () => undefined);
  }

  capture(): Promise<WorkspaceState> {
    return this.repository.capture();
  }

  captureStaged(): Promise<StagedWorkspaceState> {
    return this.repository.captureStaged();
  }

  captureFrom(rootPath: string): Promise<WorkspaceState> {
    return this.repository.captureFrom(rootPath);
  }

  captureStagedFrom(rootPath: string): Promise<StagedWorkspaceState> {
    return this.repository.captureStagedFrom(rootPath);
  }

  read(stateId: string): Promise<WorkspaceState> {
    return this.repository.read(stateId);
  }

  materialize(stateId: string, targetRoot: string): Promise<void> {
    return this.repository.materialize(stateId, targetRoot);
  }

  createChangeSet(
    taskId: string,
    baseStateId: string,
    resultStateId: string,
    scopes: readonly WorkspaceScope[],
  ): Promise<WorkspaceChangeSet> {
    return this.repository.createChangeSet(taskId, baseStateId, resultStateId, scopes);
  }

  applyChangeSet(changeSet: WorkspaceChangeSet) {
    return this.repository.applyChangeSet(changeSet);
  }

  reviewDiff(changeSet: WorkspaceChangeSet, pathFilter?: string): Promise<string> {
    return this.repository.reviewDiff(changeSet, pathFilter);
  }

  scopesOverlap(left: readonly WorkspaceScope[], right: readonly WorkspaceScope[]): boolean {
    return this.repository.differ.scopesOverlap(left, right);
  }

  taskWorkspacePath(taskId: string): string {
    if (!/^task_[A-Za-z0-9_-]+$/.test(taskId)) throw new Error(`Invalid task id: ${taskId}`);
    return path.join(this.repository.project.statePath, "agent-tasks", "workspaces", taskId);
  }

  async restore(stateId: string): Promise<void> {
    await this.repository.restore(stateId);
    this.latest = { stateId, persisted: Promise.resolve() };
  }

  verify(stateId: string): Promise<void> {
    return this.repository.verify(stateId);
  }

  async existsAndIsValid(stateId: string): Promise<boolean> {
    try {
      await this.verify(stateId);
      return true;
    } catch {
      return false;
    }
  }

  cleanup(referencedStateIds: ReadonlySet<string>): Promise<{ statesRemoved: number; blobsRemoved: number }> {
    return this.repository.garbageCollect(referencedStateIds);
  }

  private record(staged: StagedWorkspaceState): WorkspaceCheckpoint {
    const checkpoint = { stateId: staged.state.id, persisted: staged.persisted };
    this.latest = checkpoint;
    return checkpoint;
  }
}
