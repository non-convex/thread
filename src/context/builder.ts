import type { Message } from "@earendil-works/pi-ai";
import type { Turn } from "../session-tree/model.js";
import type { SessionTreeService } from "../session-tree/service.js";
import { ContextCache, pathFingerprint } from "./cache.js";

export interface BuiltContext {
  messages: Message[];
  turns: ContextTurn[];
  compactedThroughTurnId?: string;
}

export type ContextTurn = Pick<Turn, "id" | "sessionId" | "status">;

function summaryMessage(summary: string, timestamp: number): Message {
  return {
    role: "user",
    content: `[Derived project-state summary; original Session Tree history remains authoritative]\n\n${summary}`,
    timestamp,
  };
}

export class ContextBuilder {
  constructor(
    private readonly tree: SessionTreeService,
    private readonly cache: ContextCache,
  ) {}

  async build(tipTurnId?: string): Promise<BuiltContext> {
    const turns = tipTurnId ? this.tree.pathToTurn(tipTurnId) : this.tree.livePath();
    const sessionId = tipTurnId
      ? this.tree.projection.turns.get(tipTurnId)?.sessionId
      : this.tree.activeSession.id;
    if (!sessionId) throw new Error(`Unknown context tip: ${tipTurnId}`);
    const cached = await this.cache.read(sessionId);
    let start = 0;
    const messages: Message[] = [];
    let compactedThroughTurnId: string | undefined;
    if (cached) {
      const throughIndex = turns.findIndex((turn) => turn.id === cached.throughTurnId);
      const prefix = throughIndex >= 0 ? turns.slice(0, throughIndex + 1).map((turn) => turn.id) : [];
      if (throughIndex >= 0 && pathFingerprint(prefix) === cached.pathFingerprint) {
        messages.push(summaryMessage(cached.summary, cached.createdAt));
        start = throughIndex + 1;
        compactedThroughTurnId = cached.throughTurnId;
      }
    }
    for (const turn of turns.slice(start)) messages.push(...this.tree.messagesForTurn(turn.id));
    return {
      messages,
      turns,
      ...(compactedThroughTurnId ? { compactedThroughTurnId } : {}),
    };
  }

  rawMessages(turns: readonly ContextTurn[]): Message[] {
    return turns.flatMap((turn) => this.tree.messagesForTurn(turn.id));
  }
}
