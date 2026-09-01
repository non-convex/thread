import type { ContextCache } from "../../context/cache.js";
import type { RewindCandidate, SessionTreeService } from "../../session-tree/service.js";
import type { WorkspaceStateService } from "../../workspace-state/service.js";

export class Rewind {
  constructor(
    private readonly tree: SessionTreeService,
    private readonly workspace: WorkspaceStateService,
    private readonly contextCache: ContextCache,
  ) {}

  async execute(turnIdOrUserEntryId: string): Promise<RewindCandidate> {
    this.tree.requireIdle();
    const candidate = this.tree.resolveRewindCandidate(turnIdOrUserEntryId);
    await this.workspace.verify(candidate.workspaceStateId);
    await this.workspace.restore(candidate.workspaceStateId);
    const turn = this.tree.projection.turns.get(candidate.turnId);
    if (!turn) throw new Error(`Rewind target disappeared: ${candidate.turnId}`);
    await this.tree.moveLiveTipForRewind(turn.parentTurnId);
    await this.contextCache.invalidate(turn.sessionId);
    return candidate;
  }
}
