import { executionEventSink, safeExecutionEvent, type ExecutionEventSink } from "../runtime/events.js";
import { contentText } from "@earendil-works/pi-ai";
import { EphemeralAgentJournal } from "../agent/ephemeral-journal.js";
import type { AgentProfile } from "../agent/profile.js";
import { AgentStepRunner, assertModelStepSucceeded } from "../agent/step-runner.js";
import { ToolCallExecutor } from "../agent/tool-call-executor.js";
import { ExtensionEvents } from "../extensions/events.js";
import type { HostToolPolicy } from "../runtime/policy.js";
import { DREAMER_MAX_RUNTIME_MS, DREAMER_MAX_STEPS, parseDreamerReviewResult } from "./profile.js";
import { validateExecutionLimits } from "../runtime/limits.js";
import { createDreamerReviewBatch, type DreamerReviewBatch, type DreamerReviewEntry, type DreamerReviewSource } from "./review.js";
import type { DreamerAdmission, DreamerCheckpoint } from "./state.js";
import { GlobalMemoryAccess, globalMemoryRevision } from "../global-memory.js";
import { ToolRegistry } from "../tools/types.js";

export const DREAMER_IDLE_TURNS = 10;
export const DREAMER_IDLE_MS = 10 * 60_000;
export const DREAMER_MAX_WAIT_MS = 30 * 60_000;
const MIN_INPUT_BYTES = 2_048;
const MAX_INPUT_BYTES = 48 * 1_024;
const MAX_FAILURES_WITHOUT_PROGRESS = 3;

export interface DreamerStatus {
  enabled: boolean;
  phase: "disabled" | "idle" | "waiting" | "running" | "retrying" | "blocked";
  pendingTurns: number;
  reviewedTurns: number;
  partialTurnId?: string;
  oldestPendingAt?: number;
  lastReviewedAt?: number;
  lastResult?: "updated" | "unchanged" | "observed" | "read_only";
  nextReviewAt?: number;
  lastError?: string;
}

export interface DreamerSchedulerOptions {
  readTurn: (turnId: string, startOrdinal: number) => Iterable<DreamerReviewEntry>;
  pendingTurns: () => DreamerReviewSource[];
  checkpoint: () => DreamerCheckpoint;
  saveCheckpoint: (turnIds: readonly string[], checkpoint: DreamerCheckpoint, signal?: AbortSignal) => Promise<void>;
  idleTurns?: number;
  idleMs?: number;
  maxWaitMs?: number;
  maxRuntimeMs?: number;
  maxSteps?: number;
  protectedWritePaths?: readonly string[];
  toolPolicy?: HostToolPolicy;
  onEvent?: ExecutionEventSink;
}

class ReviewOverflowError extends Error {}
class ReviewBlockedError extends Error {}

/** Session Tree owns coverage; this scheduler owns only the current timer and execution. */
export class DreamerScheduler {
  private profile: AgentProfile | undefined;
  private checkpoint: DreamerCheckpoint;
  private foregroundActive = false;
  private foregroundIdleSince = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;
  private closing = false;
  private resetRequested = false;
  private persistenceError: string | undefined;
  private admissionError: string | undefined;
  private readonly idleTurns: number;
  private readonly idleMs: number;
  private readonly maxWaitMs: number;
  private readonly maxRuntimeMs: number;
  private readonly maxSteps: number;

  constructor(
    private readonly rootPath: string,
    private readonly memoryPath: string,
    profile: AgentProfile | undefined,
    private readonly options: DreamerSchedulerOptions,
  ) {
    this.profile = profile;
    this.checkpoint = options.checkpoint();
    this.idleTurns = options.idleTurns ?? DREAMER_IDLE_TURNS;
    this.idleMs = options.idleMs ?? DREAMER_IDLE_MS;
    this.maxWaitMs = options.maxWaitMs ?? DREAMER_MAX_WAIT_MS;
    this.maxRuntimeMs = options.maxRuntimeMs ?? DREAMER_MAX_RUNTIME_MS;
    this.maxSteps = options.maxSteps ?? DREAMER_MAX_STEPS;
    this.resetRequested = !!profile && this.checkpoint.modelKey !== this.modelKey(profile);
    validateExecutionLimits({ maxSteps: this.maxSteps, timeoutMs: this.maxRuntimeMs });
    for (const [name, value] of Object.entries({ idleTurns: this.idleTurns, idleMs: this.idleMs, maxWaitMs: this.maxWaitMs })) {
      if (!Number.isSafeInteger(value) || value < 1 || (name !== "idleTurns" && value > 2_147_483_647)) {
        throw new Error(`Dreamer ${name} must be a positive integer${name === "idleTurns" ? "" : " within the timer range"}`);
      }
    }
  }

  get enabled(): boolean { return this.profile !== undefined && !this.closing; }
  get lastError(): string | undefined { return this.persistenceError ?? this.admissionError ?? this.checkpoint.lastError; }
  get status(): DreamerStatus { return this.statusFor(this.options.pendingTurns()); }

  private statusFor(pending: readonly DreamerReviewSource[]): DreamerStatus {
    const blocked = !!this.persistenceError || (!!this.checkpoint.blocked && !this.resetRequested);
    const nextReviewAt = this.enabled && !this.foregroundActive && !this.running && !blocked ? this.dueAt(pending) : undefined;
    return {
      enabled: this.enabled,
      phase: !this.enabled ? "disabled" : this.running ? "running" : blocked ? "blocked" : !pending.length ? "idle"
        : this.checkpoint.lastError ? "retrying" : "waiting",
      pendingTurns: pending.length,
      reviewedTurns: this.checkpoint.reviewedTurns,
      ...(this.checkpoint.cursor ? { partialTurnId: this.checkpoint.cursor.turnId } : {}),
      ...(pending[0] ? { oldestPendingAt: pending[0].finishedAt ?? pending[0].startedAt } : {}),
      ...(this.checkpoint.lastReviewedAt !== undefined ? { lastReviewedAt: this.checkpoint.lastReviewedAt } : {}),
      ...(this.checkpoint.lastResult ? { lastResult: this.checkpoint.lastResult } : {}),
      ...(nextReviewAt !== undefined ? { nextReviewAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  start(): void { this.schedule(); }

  setProfile(profile: AgentProfile | undefined): void {
    this.profile = profile;
    this.controller?.abort(new DOMException("Dreamer configuration changed", "AbortError"));
    // Enabling/selecting a model is also an explicit retry of a blocked review.
    if (profile) this.resetRequested = true;
    this.schedule();
  }

  async admission(signal: AbortSignal): Promise<DreamerAdmission | undefined> {
    if (!this.enabled) return undefined;
    let revision: string;
    try {
      revision = await globalMemoryRevision(this.memoryPath, signal);
      this.admissionError = undefined;
    } catch (error) {
      signal.throwIfAborted();
      // A broken optional memory file must not prevent Main from admitting its turn.
      revision = "unavailable";
      this.admissionError = `Cannot observe global memory for Dreamer: ${String(error instanceof Error ? error.message : error)}`;
    }
    return { memoryPath: this.memoryPath, memoryRevision: revision };
  }

  async foregroundStarting(resetsIdle: boolean): Promise<void> {
    this.foregroundActive = true;
    if (resetsIdle) this.foregroundIdleSince = 0;
    this.clearTimer();
    this.controller?.abort(new DOMException("Foreground work takes priority", "AbortError"));
    // Settle checkpoint writes before a foreground rewind or a new turn can begin.
    await this.running;
    this.publishStatus();
  }

  foregroundFinished(resetsIdle: boolean): void {
    this.foregroundActive = false;
    if (resetsIdle) this.foregroundIdleSince = Date.now();
    this.schedule();
  }

  async close(): Promise<void> {
    this.closing = true;
    this.clearTimer();
    this.controller?.abort(new DOMException("Thread application closed", "AbortError"));
    await this.running;
    // Pending turns and the last confirmed fragment remain in the Session Tree.
  }

  private dueAt(pending: readonly DreamerReviewSource[]): number | undefined {
    const first = pending[0];
    if (!first) return undefined;
    const triggered = this.checkpoint.cursor !== undefined || this.checkpoint.retryAfter !== undefined;
    const thresholdAt = triggered || pending.length >= this.idleTurns ? 0
      : (first.finishedAt ?? first.startedAt) + this.maxWaitMs;
    return Math.max(Date.now(), this.foregroundIdleSince + this.idleMs, thresholdAt, this.checkpoint.retryAfter ?? 0);
  }

  private schedule(): void {
    this.clearTimer();
    const pending = this.options.pendingTurns();
    if (this.enabled && !this.foregroundActive && !this.running && !this.persistenceError &&
        (!this.checkpoint.blocked || this.resetRequested)) {
      const due = this.dueAt(pending);
      if (due !== undefined) this.timer = setTimeout(() => this.launch(), Math.min(2_147_483_647, Math.max(0, due - Date.now())));
    }
    this.publishStatus(pending);
  }

  private launch(): void {
    this.timer = undefined;
    if (!this.enabled || this.foregroundActive || this.running || !this.profile || this.persistenceError) return;
    const profile = this.profile;
    const controller = new AbortController();
    this.controller = controller;
    // Defer work until running has been published, including synchronous event callbacks.
    const run = Promise.resolve().then(() => this.runProfile(profile, controller.signal)).catch(async (error) => {
      if (controller.signal.aborted || this.persistenceError) return;
      const next = { ...this.checkpoint, lastError: String(error instanceof Error ? error.message : error), retryAfter: Date.now() + this.idleMs };
      if (error instanceof ReviewOverflowError) {
        const budget = this.checkpoint.inputBudget ?? this.inputBudget(profile);
        if (budget > MIN_INPUT_BYTES) next.inputBudget = Math.max(MIN_INPUT_BYTES, Math.floor(budget / 2));
        else next.blocked = true;
      } else {
        next.consecutiveFailures++;
        if (error instanceof ReviewBlockedError || next.consecutiveFailures >= MAX_FAILURES_WITHOUT_PROGRESS) next.blocked = true;
      }
      await this.save([], next);
    }).catch((error) => {
      this.persistenceError = `Dreamer progress could not be saved: ${String(error instanceof Error ? error.message : error)}`;
    }).finally(() => {
      if (this.controller === controller) this.controller = undefined;
      if (this.running === run) this.running = undefined;
      this.schedule();
    });
    this.running = run;
    this.publishStatus();
  }

  private modelKey(profile: AgentProfile): string {
    return `${profile.model.providerId}/${profile.model.modelId}/${profile.model.contextWindow}/${profile.model.maxOutputTokens}`;
  }

  private inputBudget(profile: AgentProfile): number {
    // UTF-8 bytes are a conservative planning unit, not a provider token guarantee.
    const overhead = Buffer.byteLength(profile.systemPrompt + JSON.stringify(profile.tools.modelDefinitions()), "utf8") + 2_048;
    const outputReserve = Math.min(profile.model.maxOutputTokens, Math.floor(profile.model.contextWindow / 4));
    return Math.floor(Math.min(MAX_INPUT_BYTES, profile.model.contextWindow * 0.4,
      profile.model.contextWindow - overhead - outputReserve));
  }

  private async save(turnIds: readonly string[], checkpoint: DreamerCheckpoint, signal?: AbortSignal): Promise<void> {
    try { await this.options.saveCheckpoint(turnIds, checkpoint, signal); }
    catch (error) {
      if (signal?.aborted && error === signal.reason) throw error;
      this.persistenceError = String(error instanceof Error ? error.message : error);
      throw error;
    }
    this.checkpoint = checkpoint;
  }

  private async runProfile(profile: AgentProfile, parentSignal: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(this.maxRuntimeMs)]);
    signal.throwIfAborted();
    const reset = this.resetRequested;
    this.resetRequested = false;
    const modelKey = this.modelKey(profile);
    const baseBudget = this.inputBudget(profile);
    if (baseBudget < MIN_INPUT_BYTES) throw new ReviewBlockedError("Dreamer model has too little context for its instructions, tools and review input. Select a larger model.");
    const checkpoint = { ...this.checkpoint, retryAfter: Date.now() };
    if (reset || checkpoint.modelKey !== modelKey) {
      checkpoint.inputBudget = baseBudget;
      checkpoint.modelKey = modelKey;
      checkpoint.consecutiveFailures = 0;
      delete checkpoint.lastError;
      delete checkpoint.blocked;
    }
    await this.save([], checkpoint);
    this.publishStatus();
    while (true) {
      signal.throwIfAborted();
      const pending = this.options.pendingTurns();
      if (!pending.length) {
        const done = { ...this.checkpoint };
        delete done.retryAfter;
        delete done.lastError;
        delete done.blocked;
        await this.save([], done);
        return;
      }
      const revision = await globalMemoryRevision(this.memoryPath, signal);
      this.admissionError = undefined;
      if (revision !== this.checkpoint.memoryRevision) {
        // An external/Main update may be a correction or a deletion. Old evidence cannot undo it.
        await this.save([], { ...this.checkpoint, evidence: "", memoryRevision: revision, sourceRevisions: [revision],
          ...(revision === "missing" && this.checkpoint.memoryRevision !== undefined ? { missingMemorySince: Date.now() } : {}) });
      }
      const accepted = new Set([...this.checkpoint.sourceRevisions, revision]);
      const canUseEvidence = (turn: DreamerReviewSource) => accepted.has(turn.memoryRevision) &&
        (turn.memoryRevision !== "missing" || turn.startedAt > (this.checkpoint.missingMemorySince ?? -1));
      const writable = canUseEvidence(pending[0]!);
      // Never mix obsolete evidence into a batch that is allowed to change memory.
      const boundary = pending.findIndex((turn) => canUseEvidence(turn) !== writable);
      const sources = boundary < 0 ? pending : pending.slice(0, boundary);
      const budget = Math.min(baseBudget, this.checkpoint.inputBudget ?? baseBudget);
      const evidenceLimit = Math.min(2_000, Math.floor(budget / 16));
      const evidence = writable ? this.checkpoint.evidence.slice(0, evidenceLimit) : "";
      let batch: DreamerReviewBatch | undefined;
      try {
        batch = await createDreamerReviewBatch(this.memoryPath, sources, this.options.readTurn,
          this.checkpoint.cursor, budget, evidence, signal);
      } catch (error) {
        signal.throwIfAborted();
        throw new ReviewBlockedError(`Cannot prepare Dreamer review: ${String(error instanceof Error ? error.message : error)}`);
      }
      if (!batch) throw new ReviewBlockedError("Pending Dreamer turns produced no review material");
      // Read later corrections before publishing an inference from an earlier fragment.
      const canUpdate = writable && !batch.cursor && batch.turnIds.length === pending.length;
      await this.reviewBatch(profile, batch, revision, writable, canUpdate, evidenceLimit, signal);
      // This batch only removes its confirmed prefix; foreground admissions wait for us to settle.
      this.publishStatus(pending.slice(batch.turnIds.length));
    }
  }

  private async reviewBatch(profile: AgentProfile, batch: DreamerReviewBatch, revision: string,
    writable: boolean, canUpdate: boolean, evidenceLimit: number, signal: AbortSignal): Promise<void> {
    const tools = canUpdate ? profile.tools : new ToolRegistry();
    if (!canUpdate) tools.register(profile.tools.get("read")!);
    const memory = new GlobalMemoryAccess(this.memoryPath, true, { expectedRevision: revision, validateEntries: true });
    const executor = new ToolCallExecutor(this.rootPath, tools, new ExtensionEvents(), {
      acceptsImages: false,
      writableExternalPaths: [this.memoryPath],
      protectedWritePaths: this.options.protectedWritePaths ?? [],
      globalMemory: memory,
      ...(this.options.toolPolicy ? { toolPolicy: this.options.toolPolicy } : {}),
      agentId: profile.id,
    });
    const runner = new AgentStepRunner(profile.model, executor, profile.thinkingLevel === "off" ? undefined : profile.thinkingLevel);
    const journal = new EphemeralAgentJournal([batch.message], profile.id);
    const ui = executionEventSink(journal.identity, this.options.onEvent);
    const instructions = [profile.systemPrompt,
      `For this batch, the evidence field must contain at most ${evidenceLimit} characters. Put the strongest observations first.`,
      canUpdate ? "This is the last pending batch. You may now update global memory when the complete available evidence justifies it."
        : writable ? "Later history is still pending. Review this batch and carry useful candidate evidence, but do not update memory yet: later user corrections or forget requests may override it. Only read is available."
        : "This batch predates a change to global memory by Main or an external writer. Review it for coverage only: do not change memory or retain candidate evidence from it. Return an empty evidence string. Only read is available."].join("\n\n");
    const unresolved = new Set<string>();
    let output = "";
    let error: unknown;
    safeExecutionEvent(ui, { type: "agent_run_started", input: contentText(batch.message.content, "") });
    try {
      for (let step = 1; ; step++) {
        signal.throwIfAborted();
        const result = await runner.run({ systemPrompt: instructions, messages: journal.conversationMessages(), tools: tools.modelDefinitions() },
          journal, { signal, step, onExecutionEvent: ui });
        output = contentText(result.response.content, "");
        if (runner.isContextOverflow(result.response)) throw new ReviewOverflowError("Dreamer context overflow; retrying with a smaller review fragment.");
        assertModelStepSucceeded(result, signal);
        if (result.response.stopReason === "length") throw new ReviewOverflowError("Dreamer output was truncated; this fragment remains pending.");
        for (const item of result.results) {
          if (item.role !== "toolResult") continue;
          const group = item.toolName === "write" || item.toolName === "edit" ? "memory update" : item.toolName;
          const observation = memory.readObservation;
          const missingRead = item.toolName === "read" && observation?.toolCallId === item.toolCallId && observation.missing;
          if (item.isError && !missingRead) unresolved.add(group);
          else unresolved.delete(group);
        }
        if (!result.calls.length) {
          if (result.response.stopReason !== "stop") throw new Error(`Dreamer did not finish normally: ${result.response.stopReason}`);
          if (await globalMemoryRevision(this.memoryPath, signal) !== memory.revision) {
            throw new Error("Global memory changed during review; pending evidence will be reconsidered against the new file.");
          }
          const completed = parseDreamerReviewResult(output);
          if (completed.status === "blocked") throw new ReviewBlockedError(completed.reason ?? "Dreamer could not complete this review");
          if (unresolved.size) throw new Error(`Dreamer ended with unresolved tool failures: ${[...unresolved].join(", ")}`);
          if (completed.evidence.length > evidenceLimit) throw new Error(`Dreamer evidence exceeds this batch's ${evidenceLimit}-character limit`);
          const next: DreamerCheckpoint = { ...this.checkpoint, evidence: writable ? completed.evidence : "",
            reviewedTurns: this.checkpoint.reviewedTurns + batch.turnIds.length, lastReviewedAt: Date.now(), consecutiveFailures: 0,
            lastResult: !writable ? "read_only" : !canUpdate ? "observed" : memory.revision !== revision ? "updated" : "unchanged" };
          if (batch.cursor) next.cursor = batch.cursor;
          else delete next.cursor;
          delete next.lastError;
          delete next.blocked;
          signal.throwIfAborted();
          await this.rememberOwnRevision(revision, memory.revision!);
          // rememberOwnRevision may have advanced the allowed source revisions.
          next.memoryRevision = this.checkpoint.memoryRevision!;
          next.sourceRevisions = this.checkpoint.sourceRevisions;
          signal.throwIfAborted();
          await this.save(batch.turnIds, next, signal);
          return;
        }
        if (step >= this.maxSteps) throw new Error(`Dreamer exceeded ${this.maxSteps} model steps; this fragment remains pending`);
      }
    } catch (cause) {
      error = cause;
      throw cause;
    } finally {
      // A successful file edit is not rolled back when generation later fails or is cancelled.
      // Remember our own publication without acknowledging the unfinished fragment.
      try {
        if (memory.revision && memory.revision !== revision && memory.revision !== this.checkpoint.memoryRevision) {
          await this.rememberOwnRevision(revision, memory.revision);
        }
      } catch (cause) {
        error ??= cause;
        throw cause;
      } finally {
        safeExecutionEvent(ui, { type: "agent_run_finished", output,
          outcome: signal.aborted ? "cancelled" : error !== undefined ? "failed" : "completed",
          ...(error !== undefined ? { error: String(error instanceof Error ? error.message : error) } : {}) });
      }
    }
  }

  private async rememberOwnRevision(before: string, after: string): Promise<void> {
    if (before === after) return;
    const needed = new Set(this.options.pendingTurns().map((turn) => turn.memoryRevision));
    const sourceRevisions = [...new Set([...this.checkpoint.sourceRevisions, before, after])]
      .filter((revision) => revision === after || needed.has(revision));
    await this.save([], { ...this.checkpoint, memoryRevision: after, sourceRevisions });
  }

  private publishStatus(pending?: readonly DreamerReviewSource[]): void {
    safeExecutionEvent(this.options.onEvent, { type: "dreamer_status",
      status: pending ? this.statusFor(pending) : this.status });
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
