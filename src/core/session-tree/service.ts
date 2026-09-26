import type { ImageContent, Message, UserMessage } from "@earendil-works/pi-ai";
import { emptyDreamerCheckpoint, type DreamerAdmission, type DreamerCheckpoint } from "../dreamer/state.js";
import { createId, stableId } from "../utils/id.js";
import { isEmptyUserMessageContent, userContentDisplay, userContentFrom, userContentIsEmpty } from "./user-content.js";
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
  type FileEditEntry,
  type FileRewindIntent,
  type MessageEntry,
  type ProjectSession,
  type RetainedTurn,
  type SessionEntry,
  type SessionGoal,
  type SessionTree,
  type ToolExecutionEntry,
  type Turn,
  type TurnStatus,
} from "./model.js";
import type { SessionTreeRepository } from "./repository.js";

export interface RewindCandidate {
  turnId: string;
  userEntryId: string;
  label: string;
  status: TurnStatus;
  startedAt: number;
}

/**
 * Runtime-only identity reserved before the user turn is appended to the tree.
 */
export interface PlannedTurn {
  id: string;
  sessionId: string;
  parentTurnId: string | null;
  userEntryId: string;
  input: string;
  content: UserMessage["content"];
  status: "running";
  startedAt: number;
  fileCheckpoints: boolean;
  dreamerReview?: DreamerAdmission;
  goal?: SessionGoal;
}

/** Runtime-only reserved identity used when tool facts may precede the complete assistant message. */
export interface PlannedMessageEntry {
  id: string;
  turnId: string;
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

  async initialize(): Promise<{ created: boolean; interruptedTurnIds: string[] }> {
    let created = false;
    if (!this.projection.tree) {
      const now = Date.now();
      const treeId = stableId("tree", this.repository.project.id);
      const session: ProjectSession = { id: createId("session"), treeId, createdAt: now };
      const tree: SessionTree = {
        format: SESSION_TREE_FORMAT,
        formatVersion: 2,
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
      session.id.startsWith(idOrPrefix)
    );
    if (matches.length !== 1) throw new Error(`Could not uniquely resolve session: ${idOrPrefix}`);
    return matches[0]!;
  }

  planTurn(input: string, images: readonly ImageContent[], sessionId: string, fileCheckpoints: boolean,
    dreamerReview?: DreamerAdmission, goal?: SessionGoal): PlannedTurn {
    if (userContentIsEmpty(input, images)) throw new Error("User message cannot be empty");
    this.requireIdle();
    const session = this.resolveSession(sessionId);
    return {
      id: createId("turn"),
      sessionId: session.id,
      parentTurnId: this.projection.liveTips.get(session.id) ?? null,
      userEntryId: createId("entry"),
      input,
      content: userContentFrom(input, images),
      status: "running",
      startedAt: Date.now(),
      fileCheckpoints,
      ...(dreamerReview !== undefined ? { dreamerReview: structuredClone(dreamerReview) } : {}),
      ...(goal !== undefined ? { goal: structuredClone(goal) } : {}),
    };
  }

  async startPlannedTurn(
    planned: PlannedTurn,
  ): Promise<Turn> {
    const content = planned.content;
    if (isEmptyUserMessageContent(content)) throw new Error("User message cannot be empty");
    const goal = planned.goal === undefined ? undefined : structuredClone(planned.goal);
    this.requireIdle();
    if (!this.projection.sessions.has(planned.sessionId) ||
        planned.parentTurnId !== (this.projection.liveTips.get(planned.sessionId) ?? null)) {
      throw new Error(`Planned turn ${planned.id} no longer extends its Session`);
    }
    const turn: Turn = {
      id: planned.id,
      sessionId: planned.sessionId,
      parentTurnId: planned.parentTurnId,
      userEntryId: planned.userEntryId,
      ...(goal !== undefined ? { goalId: goal.id } : {}),
      status: "running",
      startedAt: planned.startedAt,
      fileCheckpoints: planned.fileCheckpoints,
      ...(planned.dreamerReview !== undefined ? { dreamerReview: structuredClone(planned.dreamerReview) } : {}),
    };
    const userEntry: MessageEntry = {
      id: turn.userEntryId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      ordinal: 0,
      timestamp: turn.startedAt,
      type: "message",
      message: { role: "user", content, timestamp: turn.startedAt },
    };
    await this.repository.appendBatch(() => {
      if (goal !== undefined) this.projection.validateGoalChange(planned.sessionId, goal);
      return [
        { type: "turn_started", turn },
        { type: "entry_appended", entry: userEntry },
        ...(goal !== undefined ? [{ type: "goal_changed" as const, sessionId: planned.sessionId, goal }] : []),
      ];
    }, true);
    return structuredClone(turn);
  }

  readGoal(sessionId: string): SessionGoal | undefined {
    const goal = this.projection.goals.get(sessionId);
    return goal ? { ...structuredClone(goal), turnsUsed: this.projection.goalTurns.get(goal.id) ?? 0 } : undefined;
  }

  async setGoal(sessionId: string, goal: SessionGoal | null, signal?: AbortSignal): Promise<void> {
    const snapshot = structuredClone(goal);
    await this.repository.append(() => {
      signal?.throwIfAborted();
      this.projection.validateGoalChange(sessionId, snapshot);
      return { type: "goal_changed", sessionId, goal: snapshot };
    }, true);
  }

  planMessageEntry(turnId: string): PlannedMessageEntry {
    return { id: createId("entry"), turnId };
  }

  async appendMessage(
    input: { turnId: string; message: Message; entryId?: string },
    flush = false,
  ): Promise<MessageEntry> {
    return this.appendEntry<MessageEntry>(this.runningTurn(input.turnId), {
      type: "message", message: input.message, timestamp: input.message.timestamp,
      ...(input.entryId !== undefined ? { id: input.entryId } : {}),
    }, flush);
  }

  async appendToolExecution(
    input: Omit<ToolExecutionEntry, "id" | "sessionId" | "ordinal" | "timestamp" | "type">,
  ): Promise<ToolExecutionEntry> {
    return this.appendEntry<ToolExecutionEntry>(this.runningTurn(input.turnId), { ...input, type: "tool_execution" }, true);
  }

  async appendFileEdit(input: Pick<FileEditEntry, "turnId" | "path" | "before">): Promise<void> {
    await this.appendEntry<FileEditEntry>(this.runningTurn(input.turnId), { ...input, type: "file_edit" }, true);
  }

  async appendCompaction(input: {
    turnId: string;
    summary: string;
    retainedTurns: RetainedTurn[];
    tokensBefore: number;
    tokensAfter: number;
    reason: CompactionReason;
    progressSummary?: string;
  }): Promise<CompactionEntry> {
    const turn = this.projection.turns.get(input.turnId);
    if (!turn) throw new Error(`Unknown compaction turn: ${input.turnId}`);
    const appendsToLiveTip = turn.status !== "running" && this.projection.liveTips.get(turn.sessionId) === turn.id;
    if (turn.status !== "running" && !appendsToLiveTip) {
      throw new Error(`Compaction target is not the running turn or current live tip: ${turn.id}`);
    }
    return this.appendEntry<CompactionEntry>(turn, {
      type: "compaction", summary: input.summary.trim(), retainedTurns: input.retainedTurns,
      tokensBefore: input.tokensBefore, tokensAfter: input.tokensAfter, reason: input.reason,
      ...(input.progressSummary ? { progressSummary: input.progressSummary.trim() } : {}),
    });
  }

  private async appendEntry<T extends SessionEntry>(
    turn: Turn,
    input: Omit<T, "id" | "sessionId" | "turnId" | "ordinal" | "timestamp"> & { id?: string; timestamp?: number },
    flush = false,
  ): Promise<T> {
    const entry = { ...structuredClone(input), id: input.id ?? createId("entry"),
      timestamp: input.timestamp ?? Date.now(), sessionId: turn.sessionId, turnId: turn.id, ordinal: 0 } as T;
    await this.repository.append(() => {
      // Assign after the durability barrier: concurrent edits must see the latest ordinal.
      entry.ordinal = this.projection.entriesByTurn.get(turn.id)!.length;
      return { type: "entry_appended", entry };
    }, flush);
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

  async beginFileRewind(rewind: FileRewindIntent): Promise<void> {
    this.requireIdle();
    await this.repository.append(() => ({ type: "file_rewind_started", rewind }), true);
  }

  async finishFileRewind(): Promise<void> {
    const rewind = this.projection.pendingFileRewind;
    if (!rewind) throw new Error("No file rewind is pending");
    await this.repository.append(() => ({ type: "file_rewind_finished", sessionId: rewind.sessionId }), true);
  }

  async moveLiveTipForRewind(turnId: string | null, sessionId: string): Promise<void> {
    this.requireIdle();
    await this.repository.append(() => ({
      type: "live_tip_changed",
      sessionId,
      turnId,
      reason: "rewind",
    }), true);
  }

  pendingDreamerTurns(memoryPath: string): Turn[] {
    return [...this.projection.turns.values()]
      .filter((turn) => turn.status !== "running" && turn.dreamerReview?.memoryPath === memoryPath &&
        turn.dreamerReviewedAt === undefined)
      .map((turn) => structuredClone(turn));
  }

  dreamerCheckpoint(memoryPath: string): DreamerCheckpoint {
    return structuredClone(this.projection.dreamerCheckpoints.get(memoryPath) ?? emptyDreamerCheckpoint());
  }

  async checkpointDreamer(memoryPath: string, turnIds: readonly string[], checkpoint: DreamerCheckpoint, signal?: AbortSignal): Promise<void> {
    const ids = [...turnIds];
    const snapshot = structuredClone(checkpoint);
    await this.repository.append(() => {
      // Once admitted, the record finishes durably even if cancellation arrives during I/O.
      signal?.throwIfAborted();
      this.projection.validateDreamerReview(memoryPath, ids, snapshot);
      return { type: "dreamer_reviewed", memoryPath, turnIds: ids, checkpoint: snapshot };
    }, true);
  }

  livePath(sessionId: string): Turn[] {
    return livePath(this.projection, sessionId);
  }

  pathToTurn(turnId: string): Turn[] {
    return pathToTurn(this.projection, turnId);
  }

  entriesForTurn(turnId: string): SessionEntry[] {
    return (this.projection.entriesByTurn.get(turnId) ?? []).map((entry) => structuredClone(entry));
  }

  messagesForTurn(turnId: string): Message[] {
    return (this.projection.entriesByTurn.get(turnId) ?? [])
      .filter((entry): entry is MessageEntry => entry.type === "message")
      .map((entry) => structuredClone(entry.message));
  }

  rewindCandidates(sessionId: string): RewindCandidate[] {
    return this.livePath(sessionId).map((turn) => {
      const entry = this.projection.entries.get(turn.userEntryId);
      if (!entry || entry.type !== "message" || entry.message.role !== "user") {
        throw new Error(`Turn ${turn.id} has no valid user entry`);
      }
      const label = userContentDisplay(entry.message.content).replace(/\s+/g, " ").slice(0, 140) || "(empty user message)";
      return {
        turnId: turn.id,
        userEntryId: turn.userEntryId,
        label,
        status: turn.status,
        startedAt: turn.startedAt,
      };
    });
  }

  resolveRewindCandidate(idOrPrefix: string, sessionId: string): RewindCandidate {
    const matches = this.rewindCandidates(sessionId).filter((candidate) =>
      candidate.turnId.startsWith(idOrPrefix) || candidate.userEntryId.startsWith(idOrPrefix)
    );
    if (matches.length !== 1) throw new Error(`Could not uniquely resolve a current-path user turn: ${idOrPrefix}`);
    return matches[0]!;
  }

  requireIdle(): void {
    if (this.projection.pendingFileRewind) {
      throw new Error("A file rewind is unfinished. Resolve the reported file error and reopen the project to resume it before continuing.");
    }
    const running = this.projection.runningTurnsBySession.values().next().value;
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
