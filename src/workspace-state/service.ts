import type { StagedWorkspaceState, WorkspaceState } from "./model.js";
import type { WorkspaceStateRepository } from "./repository.js";

export class WorkspaceStateService {
  constructor(readonly repository: WorkspaceStateRepository) {}

  capture(): Promise<WorkspaceState> {
    return this.repository.capture();
  }

  captureStaged(): Promise<StagedWorkspaceState> {
    return this.repository.captureStaged();
  }

  restore(stateId: string): Promise<void> {
    return this.repository.restore(stateId);
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
}
