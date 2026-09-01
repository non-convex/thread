import type {
  ProjectSession,
  SessionEntry,
  SessionTree,
  SessionTreeEvent,
  SessionTreeRecord,
  Turn,
} from "./model.js";

export class SessionTreeCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionTreeCorruptionError";
  }
}

function assertUnused<T>(values: Map<string, T>, id: string, label: string): void {
  if (values.has(id)) throw new SessionTreeCorruptionError(`Duplicate ${label}: ${id}`);
}

export class SessionTreeProjection {
  tree: SessionTree | undefined;
  activeSessionId: string | undefined;
  readonly sessions = new Map<string, ProjectSession>();
  readonly turns = new Map<string, Turn>();
  readonly entries = new Map<string, SessionEntry>();
  readonly entriesByTurn = new Map<string, SessionEntry[]>();
  readonly liveTips = new Map<string, string | null>();
  nextSequence = 1;

  applyRecord(record: SessionTreeRecord): void {
    if (!Number.isSafeInteger(record.sequence) || record.sequence !== this.nextSequence) {
      throw new SessionTreeCorruptionError(
        `Expected Session Tree record ${this.nextSequence}, received ${String(record.sequence)}`,
      );
    }
    if (!Number.isFinite(record.timestamp)) throw new SessionTreeCorruptionError("Invalid record timestamp");
    const events = record.type === "batch" ? record.events : [record];
    for (const event of events) this.applyEvent(event);
    this.nextSequence++;
    if (this.tree) this.tree.updatedAt = Math.max(this.tree.updatedAt, record.timestamp);
  }

  private applyEvent(event: SessionTreeEvent): void {
    switch (event.type) {
      case "tree_created":
        if (this.tree) throw new SessionTreeCorruptionError("Session Tree was created more than once");
        if (event.tree.format !== "thread-session-tree-v1" || event.tree.formatVersion !== 1 ||
            typeof event.tree.id !== "string" || typeof event.tree.projectId !== "string" ||
            typeof event.tree.rootId !== "string" || typeof event.tree.rootPath !== "string") {
          throw new SessionTreeCorruptionError("Unsupported or invalid Session Tree metadata");
        }
        this.tree = structuredClone(event.tree);
        return;
      case "session_created":
        if (!this.tree) throw new SessionTreeCorruptionError("Session was created before the tree");
        assertUnused(this.sessions, event.session.id, "session");
        if (!event.session.id || !Number.isFinite(event.session.createdAt)) {
          throw new SessionTreeCorruptionError("Invalid Session creation record");
        }
        if (event.session.treeId !== this.tree.id) throw new SessionTreeCorruptionError("Session belongs to another tree");
        this.sessions.set(event.session.id, structuredClone(event.session));
        this.liveTips.set(event.session.id, null);
        return;
      case "active_session_changed":
        if (!this.sessions.has(event.sessionId)) throw new SessionTreeCorruptionError(`Unknown session: ${event.sessionId}`);
        if (!["created", "new", "opened"].includes(event.reason)) {
          throw new SessionTreeCorruptionError(`Unknown active Session change reason: ${String(event.reason)}`);
        }
        if ([...this.turns.values()].some((turn) => turn.status === "running")) {
          throw new SessionTreeCorruptionError("Active Session changed while a turn was running");
        }
        this.activeSessionId = event.sessionId;
        return;
      case "turn_started": {
        const turn = event.turn;
        assertUnused(this.turns, turn.id, "turn");
        if (!this.sessions.has(turn.sessionId)) throw new SessionTreeCorruptionError(`Turn ${turn.id} has no session`);
        if (this.activeSessionId !== turn.sessionId) throw new SessionTreeCorruptionError(`Turn ${turn.id} started outside the active Session`);
        if (turn.status !== "running") throw new SessionTreeCorruptionError(`Turn ${turn.id} did not start running`);
        if (!turn.workspaceStateId) throw new SessionTreeCorruptionError(`Turn ${turn.id} has no workspace state`);
        if ([...this.turns.values()].some((item) => item.status === "running")) {
          throw new SessionTreeCorruptionError(`Turn ${turn.id} started while another turn was running`);
        }
        if ((this.liveTips.get(turn.sessionId) ?? null) !== turn.parentTurnId) {
          throw new SessionTreeCorruptionError(`Turn ${turn.id} does not extend its Session live tip`);
        }
        if (turn.parentTurnId !== null) {
          const parent = this.turns.get(turn.parentTurnId);
          if (!parent || parent.sessionId !== turn.sessionId || parent.status !== "completed") {
            throw new SessionTreeCorruptionError(`Turn ${turn.id} has an invalid parent`);
          }
        }
        this.turns.set(turn.id, structuredClone(turn));
        this.entriesByTurn.set(turn.id, []);
        return;
      }
      case "entry_appended": {
        const entry = event.entry;
        assertUnused(this.entries, entry.id, "entry");
        if (entry.type !== "message" && entry.type !== "tool_execution") {
          throw new SessionTreeCorruptionError(`Unknown entry type: ${String((entry as { type?: unknown }).type)}`);
        }
        const turn = this.turns.get(entry.turnId);
        if (!turn || turn.sessionId !== entry.sessionId) {
          throw new SessionTreeCorruptionError(`Entry ${entry.id} has no matching turn`);
        }
        if (turn.status !== "running") throw new SessionTreeCorruptionError(`Entry ${entry.id} was appended to a closed turn`);
        const turnEntries = this.entriesByTurn.get(turn.id)!;
        if (entry.ordinal !== turnEntries.length) {
          throw new SessionTreeCorruptionError(`Entry ${entry.id} has ordinal ${entry.ordinal}; expected ${turnEntries.length}`);
        }
        if (entry.ordinal === 0 && (entry.type !== "message" || entry.message.role !== "user" ||
            entry.id !== turn.userEntryId)) {
          throw new SessionTreeCorruptionError(`Turn ${turn.id} does not begin with its user entry`);
        }
        const cloned = structuredClone(entry);
        this.entries.set(entry.id, cloned);
        turnEntries.push(cloned);
        return;
      }
      case "turn_finished": {
        const turn = this.turns.get(event.turnId);
        if (!turn || turn.status !== "running") throw new SessionTreeCorruptionError(`Cannot finish turn ${event.turnId}`);
        if (!["completed", "interrupted", "failed"].includes(event.status)) {
          throw new SessionTreeCorruptionError(`Unknown turn status: ${String(event.status)}`);
        }
        if (!this.entries.has(turn.userEntryId)) throw new SessionTreeCorruptionError(`Turn ${turn.id} has no user entry`);
        turn.status = event.status;
        turn.finishedAt = event.finishedAt;
        if (event.error) turn.error = structuredClone(event.error);
        return;
      }
      case "live_tip_changed": {
        if (!this.sessions.has(event.sessionId)) throw new SessionTreeCorruptionError(`Unknown session: ${event.sessionId}`);
        if (event.reason !== "turn" && event.reason !== "rewind") {
          throw new SessionTreeCorruptionError(`Unknown live-tip change reason: ${String(event.reason)}`);
        }
        if (event.turnId !== null) {
          const turn = this.turns.get(event.turnId);
          if (!turn || turn.sessionId !== event.sessionId || turn.status !== "completed") {
            throw new SessionTreeCorruptionError(`Invalid live tip: ${event.turnId}`);
          }
        }
        const currentTip = this.liveTips.get(event.sessionId) ?? null;
        if (event.reason === "turn") {
          const next = event.turnId ? this.turns.get(event.turnId) : undefined;
          if (!next || next.parentTurnId !== currentTip) {
            throw new SessionTreeCorruptionError(`Completed turn does not extend the current live tip: ${event.turnId}`);
          }
        } else if (!this.isAncestor(event.turnId, currentTip)) {
          throw new SessionTreeCorruptionError(`Rewind target is not on the current live path: ${event.turnId}`);
        }
        this.liveTips.set(event.sessionId, event.turnId);
        return;
      }
      default:
        throw new SessionTreeCorruptionError(`Unknown Session Tree event: ${String((event as { type?: unknown }).type)}`);
    }
  }

  private isAncestor(candidate: string | null, descendant: string | null): boolean {
    if (candidate === null) return true;
    let current = descendant;
    const seen = new Set<string>();
    while (current) {
      if (current === candidate) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      current = this.turns.get(current)?.parentTurnId ?? null;
    }
    return false;
  }

  activeSession(): ProjectSession {
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined;
    if (!session) throw new Error("Session Tree has no active session");
    return session;
  }
}
