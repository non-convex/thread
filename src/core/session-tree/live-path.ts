import type { Turn } from "./model.js";
import type { SessionTreeProjection } from "./projection.js";

export function livePath(projection: SessionTreeProjection, sessionId: string): Turn[] {
  if (!projection.sessions.has(sessionId)) throw new Error(`Unknown session: ${sessionId}`);
  const reversed: Turn[] = [];
  const seen = new Set<string>();
  let current = projection.liveTips.get(sessionId) ?? null;
  while (current) {
    if (seen.has(current)) throw new Error(`Cycle in Session Tree at turn ${current}`);
    seen.add(current);
    const turn = projection.turns.get(current);
    if (!turn || turn.sessionId !== sessionId) throw new Error(`Broken live path at turn ${current}`);
    reversed.push(turn);
    current = turn.parentTurnId;
  }
  return reversed.reverse().map((turn) => structuredClone(turn));
}

export function pathToTurn(projection: SessionTreeProjection, turnId: string): Turn[] {
  const turn = projection.turns.get(turnId);
  if (!turn) throw new Error(`Unknown turn: ${turnId}`);
  const reversed: Turn[] = [];
  const seen = new Set<string>();
  let current: Turn | undefined = turn;
  while (current) {
    if (seen.has(current.id)) throw new Error(`Cycle in Session Tree at turn ${current.id}`);
    seen.add(current.id);
    reversed.push(current);
    current = current.parentTurnId ? projection.turns.get(current.parentTurnId) : undefined;
  }
  return reversed.reverse().map((item) => structuredClone(item));
}
