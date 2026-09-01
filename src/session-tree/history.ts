import type { SessionTreeService } from "./service.js";

export interface SessionHistorySummary {
  sessionId: string;
  active: boolean;
  liveTipTurnId: string | null;
  turnCount: number;
  createdAt: number;
}

export function listSessionHistory(tree: SessionTreeService): SessionHistorySummary[] {
  const counts = new Map<string, number>();
  for (const turn of tree.projection.turns.values()) {
    counts.set(turn.sessionId, (counts.get(turn.sessionId) ?? 0) + 1);
  }
  return [...tree.projection.sessions.values()]
    .map((session) => ({
      sessionId: session.id,
      active: session.id === tree.activeSession.id,
      liveTipTurnId: tree.projection.liveTips.get(session.id) ?? null,
      turnCount: counts.get(session.id) ?? 0,
      createdAt: session.createdAt,
    }))
    .sort((left, right) => right.createdAt - left.createdAt);
}
