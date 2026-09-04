import type { Message } from "@earendil-works/pi-ai";
import { EphemeralAgentJournal } from "../agent/ephemeral-journal.js";
import type { AgentProfile } from "../agent/profile.js";
import { AgentStepRunner } from "../agent/step-runner.js";
import { ToolCallExecutor } from "../agent/tool-call-executor.js";
import { ExtensionEvents } from "../extensions/events.js";
import { settlesWithin } from "../utils/async.js";
import { DREAMER_MAX_RUNTIME_MS } from "./profile.js";
import { createDreamerReviewBatches } from "./review.js";

export const DREAMER_IDLE_TURNS = 10;
export const DREAMER_IDLE_MS = 10 * 60_000;
export const DREAMER_SHUTDOWN_GRACE_MS = 2_000;

export interface DreamerSchedulerOptions {
  idleTurns?: number;
  idleMs?: number;
  maxRuntimeMs?: number;
}

/** Reviews accumulated turns after the Main agent has remained idle long enough. */
export class DreamerScheduler {
  private profile: AgentProfile | undefined;
  /** Settled turns that have not yet reached a review trigger. */
  private readonly waitingTurns: Message[][] = [];
  /** Triggered snapshot retained across partial completion and retries. */
  private readonly reviewBacklog: Message[][] = [];
  private foregroundActive = false;
  private foregroundIdleSince = Date.now();
  private retryAfter = 0;
  private timer: NodeJS.Timeout | undefined;
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;
  private closing = false;
  private currentError: string | undefined;
  private readonly idleTurns: number;
  private readonly idleMs: number;
  private readonly maxRuntimeMs: number;

  constructor(
    private readonly rootPath: string,
    private readonly memoryPath: string,
    profile?: AgentProfile,
    options: DreamerSchedulerOptions = {},
  ) {
    this.profile = profile;
    this.idleTurns = options.idleTurns ?? DREAMER_IDLE_TURNS;
    this.idleMs = options.idleMs ?? DREAMER_IDLE_MS;
    this.maxRuntimeMs = options.maxRuntimeMs ?? DREAMER_MAX_RUNTIME_MS;
  }

  get enabled(): boolean { return this.profile !== undefined && !this.closing; }
  get lastError(): string | undefined { return this.currentError; }

  setProfile(profile: AgentProfile | undefined): void {
    this.profile = profile;
    this.currentError = undefined;
    if (!profile) {
      this.clearTimer();
      this.controller?.abort(new DOMException("Dreamer disabled", "AbortError"));
      this.clearPending();
      return;
    }
    this.schedule();
  }

  recordTurn(messages: readonly Message[]): void {
    if (!this.enabled) return;
    this.waitingTurns.push(messages.map((message) => structuredClone(message)));
    this.schedule();
  }

  foregroundStarting(): void {
    this.foregroundActive = true;
    this.foregroundIdleSince = 0;
    this.clearTimer();
  }

  foregroundFinished(): void {
    this.foregroundActive = false;
    this.foregroundIdleSince = Date.now();
    this.schedule();
  }

  async close(): Promise<void> {
    this.closing = true;
    this.clearTimer();
    this.controller?.abort(new DOMException("Thread application closed", "AbortError"));
    const running = this.running;
    if (running) await settlesWithin(running, DREAMER_SHUTDOWN_GRACE_MS);
    this.clearPending();
  }

  private clearPending(): void {
    this.waitingTurns.splice(0);
    this.reviewBacklog.splice(0);
    this.retryAfter = 0;
  }

  private schedule(): void {
    this.clearTimer();
    const hasTriggeredReview = this.reviewBacklog.length > 0;
    const hasEnoughWaitingTurns = this.waitingTurns.length > 0 && this.waitingTurns.length >= this.idleTurns;
    if (this.closing || this.foregroundActive || this.running || !this.profile ||
        (!hasTriggeredReview && !hasEnoughWaitingTurns)) {
      return;
    }
    const now = Date.now();
    const idleRemaining = Math.max(0, this.idleMs - (now - this.foregroundIdleSince));
    const retryRemaining = Math.max(0, this.retryAfter - now);
    this.timer = setTimeout(() => this.launch(), Math.max(idleRemaining, retryRemaining));
  }

  private launch(): void {
    this.timer = undefined;
    if (this.closing || this.foregroundActive || this.running || !this.profile) return;
    if (this.reviewBacklog.length === 0) {
      if (this.waitingTurns.length === 0 || this.waitingTurns.length < this.idleTurns) return;
      this.reviewBacklog.push(...this.waitingTurns.splice(0));
    }
    const profile = this.profile;
    const turns = this.reviewBacklog.slice();
    const controller = new AbortController();
    this.controller = controller;
    const run = this.runProfile(profile, turns, controller.signal, (completedTurns) => {
      this.reviewBacklog.splice(0, completedTurns);
    })
      .then(() => {
        this.retryAfter = 0;
        this.currentError = undefined;
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        this.retryAfter = Date.now() + this.idleMs;
        this.currentError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        if (this.controller === controller) this.controller = undefined;
        if (this.running === run) this.running = undefined;
        this.schedule();
      });
    this.running = run;
    void run.catch(() => undefined);
  }

  private async runProfile(
    profile: AgentProfile,
    turns: readonly (readonly Message[])[],
    parentSignal: AbortSignal,
    onBatchReviewed: (turnCount: number) => void,
  ): Promise<void> {
    const timeout = AbortSignal.timeout(this.maxRuntimeMs);
    const signal = AbortSignal.any([parentSignal, timeout]);
    const batches = createDreamerReviewBatches(this.memoryPath, turns, profile.model.contextWindow);
    const toolRunner = new ToolCallExecutor(
      this.rootPath,
      profile.tools,
      new ExtensionEvents(),
      undefined,
      [this.memoryPath],
    );
    const maxOutputTokens = Math.min(
      profile.model.maxOutputTokens,
      16_384,
      Math.max(1_024, Math.floor(profile.model.contextWindow * 0.2)),
    );
    const reasoning = profile.thinkingLevel === "off" ? undefined : profile.thinkingLevel;
    const runner = new AgentStepRunner(profile.model, toolRunner, maxOutputTokens, reasoning);

    for (const batch of batches) {
      const journal = new EphemeralAgentJournal([batch.message]);
      for (let step = 1; ; step++) {
        signal.throwIfAborted();
        const result = await runner.run({
          systemPrompt: profile.systemPrompt,
          messages: journal.conversationMessages(),
          tools: profile.tools.modelDefinitions(),
        }, journal, { signal, step });
        if (result.response.stopReason === "aborted") {
          throw new DOMException(result.response.errorMessage ?? "Aborted", "AbortError");
        }
        if (result.response.stopReason === "error") {
          throw new Error(result.response.errorMessage ?? "Dreamer model request failed");
        }
        if (result.calls.length === 0) break;
      }
      signal.throwIfAborted();
      onBatchReviewed(batch.turnCount);
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
