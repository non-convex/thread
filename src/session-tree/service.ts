import type { Message } from "@earendil-works/pi-ai";
import { createId, stableId } from "../utils/id.js";
import {
  abortedToolResult,
  needsPlaceholderAssistant,
  placeholderAssistant,
  toolResultTextFor,
  unmatchedToolCalls,
} from "./conversation-seal.js";
import { livePath, pathToTurn } from "./live-path.js";
import {
  SESSION_TREE_FORMAT,
  type CompactionEntry,
  type CompactionReason,
  type MessageEntry,
  type ProjectSession,
  type RetainedTurn,
  type SessionEntry,
  type SessionTree,
  type ToolExecutionEntry,
  type Turn,
  type TurnStatus,
} from "./model.js";
import type { SessionTreeRepository } from "./repository.js";

export interface RewindCandidate {
  turnId: string;
  userEntryId: string;
  workspaceStateId: string;
  label: string;
  status: TurnStatus;
  startedAt: number;
}

/**
 * Runtime-only identity for a user turn whose workspace checkpoint may still
 * be resolving. It is never written to the Session Tree on its own.
 */
export interface PlannedTurn {
  id: string;
  sessionId: string;
  parentTurnId: string | null;
  userEntryId: string;
  input: string;
  status: "running";
  startedAt: number;
}

/** Runtime-only reserved identity used when tool facts may precede the complete assistant message. */
export interface PlannedMessageEntry {
  id: string;
  turnId: string;
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.type === "text" ? block.text : "")
    .join(" ")
    .trim();
}

export class SessionTreeService {
  constructor(readonly repository: SessionTreeRepository) {}

  get projection() {
    return this.repository.projection;
  }

  get tree(): SessionTree {
    const tree = this.projection.tree;
    if (!tree) throw new Error("Session Tree is not initialized");
    return tree;
  }

  get activeSession(): ProjectSession {
    return this.projection.activeSession();
  }

  get activeLiveTip(): string | null {
    return this.projection.liveTips.get(this.activeSession.id) ?? null;
  }

  async initialize(): Promise<{ created: boolean; interruptedTurnIds: string[] }> {
    let created = false;
    if (!this.projection.tree) {
      const now = Date.now();
      const treeId = stableId("tree", this.repository.project.id);
      const session: ProjectSession = { id: createId("session"), treeId, createdAt: now };
      const tree: SessionTree = {
        format: SESSION_TREE_FORMAT,
        formatVersion: 1,
        id: treeId,
        projectId: this.repository.project.id,
        rootId: `${treeId}:root`,
        rootPath: this.repository.project.rootPath,
        createdAt: now,
        updatedAt: now,
      };
      await this.repository.appendBatch(() => [
        { type: "tree_created", tree },
        { type: "session_created", session },
        { type: "active_session_changed", sessionId: session.id, reason: "created" },
      ], true);
      await this.repository.writeManifest();
      created = true;
    } else if (this.tree.projectId !== this.repository.project.id ||
        this.tree.rootPath !== this.repository.project.rootPath) {
      throw new Error("Session Tree project identity does not match the opened project");
    }
    const interruptedTurnIds = await this.interruptRunningTurns();
    await this.repository.writeManifest();
    return { created, interruptedTurnIds };
  }

  async createSession(): Promise<ProjectSession> {
    this.requireIdle();
    const session: ProjectSession = { id: createId("session"), treeId: this.tree.id, createdAt: Date.now() };
    await this.repository.appendBatch(() => [
      { type: "session_created", session },
      { type: "active_session_changed", sessionId: session.id, reason: "new" },
    ], true);
    return structuredClone(session);
  }

  async openSession(sessionIdOrPrefix: string): Promise<ProjectSession> {
    this.requireIdle();
    const session = this.resolveSession(sessionIdOrPrefix);
    if (session.id !== this.activeSession.id) {
      await this.repository.append(() => ({ type: "active_session_changed", sessionId: session.id, reason: "opened" }), true);
    }
    return structuredClone(session);
  }

  resolveSession(idOrPrefix: string): ProjectSession {
    const matches = [...this.projection.sessions.values()].filter((session) =>
      session.id === idOrPrefix || session.id.startsWith(idOrPrefix)
    );
    if (matches.length !== 1) throw new Error(`Could not uniquely resolve session: ${idOrPrefix}`);
    return matches[0]!;
  }

  planTurn(input: string): PlannedTurn {
    if (!input.trim()) throw new Error("User message cannot be empty");
    this.requireIdle();
    return {
      id: createId("turn"),
      sessionId: this.activeSession.id,
      parentTurnId: this.activeLiveTip,
      userEntryId: createId("entry"),
      input,
      status: "running",
      startedAt: Date.now(),
    };
  }

  async startTurn(input: string, workspaceStateId: string, persistAfter?: Promise<unknown>): Promise<Turn> {
    return this.startPlannedTurn(this.planTurn(input), workspaceStateId, persistAfter);
  }

  async startPlannedTurn(
    planned: PlannedTurn,
    workspaceStateId: string,
    persistAfter?: Promise<unknown>,
  ): Promise<Turn> {
    if (!planned.input.trim()) throw new Error("User message cannot be empty");
    this.requireIdle();
    if (planned.sessionId !== this.activeSession.id || planned.parentTurnId !== this.activeLiveTip) {
      throw new Error(`Planned turn ${planned.id} no longer extends the active Session`);
    }
    const turn: Turn = {
      id: planned.id,
      sessionId: planned.sessionId,
      parentTurnId: planned.parentTurnId,
      userEntryId: planned.userEntryId,
      workspaceStateId,
      status: "running",
      startedAt: planned.startedAt,
    };
    const userEntry: MessageEntry = {
      id: turn.userEntryId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      ordinal: 0,
      timestamp: turn.startedAt,
      type: "message",
      message: { role: "user", content: planned.input, timestamp: turn.startedAt },
    };
    await this.repository.appendBatch(() => [
      { type: "turn_started", turn },
      { type: "entry_appended", entry: userEntry },
    ], false, persistAfter);
    return structuredClone(turn);
  }

  planMessageEntry(turnId: string): PlannedMessageEntry {
    return { id: createId("entry"), turnId };
  }

  async appendMessage(
    input: { turnId: string; message: Message; entryId?: string },
    flush = false,
  ): Promise<MessageEntry> {
    const turn = this.runningTurn(input.turnId);
    const entries = this.projection.entriesByTurn.get(turn.id)!;
    const entry: MessageEntry = {
      id: input.entryId ?? createId("entry"),
      sessionId: turn.sessionId,
      turnId: turn.id,
      ordinal: entries.length,
      timestamp: input.message.timestamp,
      type: "message",
      message: structuredClone(input.message),
    };
    await this.repository.append(() => ({ type: "entry_appended", entry }), flush);
    return structuredClone(entry);
  }

  async appendToolExecution(
    input: Omit<ToolExecutionEntry, "id" | "sessionId" | "ordinal" | "timestamp" | "type">,
  ): Promise<ToolExecutionEntry> {
    const turn = this.runningTurn(input.turnId);
    const entries = this.projection.entriesByTurn.get(turn.id)!;
    const entry: ToolExecutionEntry = {
      id: createId("entry"),
      sessionId: turn.sessionId,
      ordinal: entries.length,
      timestamp: Date.now(),
      type: "tool_execution",
      ...structuredClone(input),
    };
    await this.repository.append(() => ({ type: "entry_appended", entry }), true);
    return structuredClone(entry);
  }

  async appendCompaction(input: {
    turnId: string;
    summary: string;
    retainedTurns: RetainedTurn[];
    tokensBefore: number;
    reason: CompactionReason;
  }): Promise<CompactionEntry> {
    const turn = this.projection.turns.get(input.turnId);
    if (!turn) throw new Error(`Unknown compaction turn: ${input.turnId}`);
    const appendsToLiveTip = turn.status !== "running" && this.projection.liveTips.get(turn.sessionId) === turn.id;
    if (turn.status !== "running" && !appendsToLiveTip) {
      throw new Error(`Compaction target is not the running turn or current live tip: ${turn.id}`);
    }
    const entries = this.projection.entriesByTurn.get(turn.id)!;
    const entry: CompactionEntry = {
      id: createId("entry"),
      sessionId: turn.sessionId,
      turnId: turn.id,
      ordinal: entries.length,
      timestamp: Date.now(),
      type: "compaction",
      summary: input.summary.trim(),
      retainedTurns: structuredClone(input.retainedTurns),
      tokensBefore: input.tokensBefore,
      reason: input.reason,
    };
    await this.repository.append(() => ({ type: "entry_appended", entry }));
    return structuredClone(entry);
  }

  async finishTurn(turnId: string, status: Exclude<TurnStatus, "running">, error?: Error): Promise<Turn> {
    const turn = this.runningTurn(turnId);
    const finishedAt = Date.now();
    const errorValue = error ? { code: error.name || "Error", message: error.message } : undefined;
    await this.repository.appendBatch(() => [
      {
        type: "turn_finished",
        turnId,
        status,
        finishedAt,
        ...(errorValue ? { error: errorValue } : {}),
      },
      { type: "live_tip_changed", sessionId: turn.sessionId, turnId, reason: "turn" },
    ], true);
    return structuredClone(this.projection.turns.get(turnId)!);
  }

  async moveLiveTipForRewind(turnId: string | null): Promise<void> {
    this.requireIdle();
    await this.repository.append(() => ({
      type: "live_tip_changed",
      sessionId: this.activeSession.id,
      turnId,
      reason: "rewind",
    }), true);
  }

  livePath(sessionId = this.activeSession.id): Turn[] {
    return livePath(this.projection, sessionId);
  }

  pathToTurn(turnId: string): Turn[] {
    return pathToTurn(this.projection, turnId);
  }

  entriesForTurn(turnId: string): SessionEntry[] {
    return (this.projection.entriesByTurn.get(turnId) ?? []).map((entry) => structuredClone(entry));
  }

  messagesForTurn(turnId: string): Message[] {
    return this.entriesForTurn(turnId)
      .filter((entry): entry is MessageEntry => entry.type === "message")
      .map((entry) => structuredClone(entry.message));
  }

  rewindCandidates(): RewindCandidate[] {
    return this.livePath().map((turn) => {
      const entry = this.projection.entries.get(turn.userEntryId);
      if (!entry || entry.type !== "message" || entry.message.role !== "user") {
        throw new Error(`Turn ${turn.id} has no valid user entry`);
      }
      const label = messageText(entry.message).replace(/\s+/g, " ").slice(0, 140) || "(empty user message)";
      return {
        turnId: turn.id,
        userEntryId: turn.userEntryId,
        workspaceStateId: turn.workspaceStateId,
        label,
        status: turn.status,
        startedAt: turn.startedAt,
      };
    });
  }

  resolveRewindCandidate(idOrPrefix: string): RewindCandidate {
    const matches = this.rewindCandidates().filter((candidate) =>
      candidate.turnId === idOrPrefix || candidate.userEntryId === idOrPrefix ||
      candidate.turnId.startsWith(idOrPrefix) || candidate.userEntryId.startsWith(idOrPrefix)
    );
    if (matches.length !== 1) throw new Error(`Could not uniquely resolve a current-path user turn: ${idOrPrefix}`);
    return matches[0]!;
  }

  requireIdle(): void {
    const running = [...this.projection.turns.values()].find((turn) => turn.status === "running");
    if (running) throw new Error(`Turn ${running.id} is still running`);
  }

  private runningTurn(turnId: string): Turn {
    const turn = this.projection.turns.get(turnId);
    if (!turn || turn.status !== "running") throw new Error(`Turn is not running: ${turnId}`);
    return turn;
  }

  /**
   * Make a running turn a valid conversation prefix before it is closed:
   * unmatched tool calls get aborted results, and a turn that never produced an
   * assistant message gets a placeholder so the next user turn can continue.
   */
  async sealRunningTurn(
    turnId: string,
    status: Exclude<TurnStatus, "running">,
    error?: Error,
  ): Promise<void> {
    this.runningTurn(turnId);
    const prior = this.pathToTurn(turnId).flatMap((turn) => this.messagesForTurn(turn.id));
    if (needsPlaceholderAssistant(this.messagesForTurn(turnId))) {
      await this.appendMessage({
        turnId,
        message: placeholderAssistant({ messages: prior, status, ...(error ? { error } : {}) }),
      });
    }
    const missing = unmatchedToolCalls(this.messagesForTurn(turnId));
    const text = toolResultTextFor(status, error);
    for (const call of missing) {
      await this.appendMessage({ turnId, message: abortedToolResult(call, text) });
    }
  }

  private async interruptRunningTurns(): Promise<string[]> {
    const running = [...this.projection.turns.values()].filter((turn) => turn.status === "running");
    const error = new Error("Thread stopped before this turn completed");
    error.name = "Interrupted";
    for (const turn of running) {
      await this.sealRunningTurn(turn.id, "interrupted", error);
      await this.finishTurn(turn.id, "interrupted", error);
    }
    return running.map((turn) => turn.id);
  }
}
