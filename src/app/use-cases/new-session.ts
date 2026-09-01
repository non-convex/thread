import type { ProjectSession } from "../../session-tree/model.js";
import type { SessionTreeService } from "../../session-tree/service.js";

export class NewSession {
  constructor(private readonly tree: SessionTreeService) {}

  execute(): Promise<ProjectSession> {
    return this.tree.createSession();
  }
}
