import { executionEventSink, safeExecutionEvent, type ExecutionEventSink } from "../runtime/events.js";
import { contentText, type Message } from "@earendil-works/pi-ai";
import { EphemeralAgentJournal } from "../agent/ephemeral-journal.js";
import type { AgentProfile } from "../agent/profile.js";
import { AgentStepRunner, assertModelStepSucceeded } from "../agent/step-runner.js";
import { ToolCallExecutor } from "../agent/tool-call-executor.js";
import { ExtensionEvents } from "../extensions/events.js";
import type { HostToolPolicy } from "../runtime/policy.js";
import { DREAMER_MAX_RUNTIME_MS, DREAMER_MAX_STEPS } from "./profile.js";
import { validateExecutionLimits } from "../runtime/limits.js";
import { createDreamerReviewBatches } from "./review.js";
import { GlobalMemoryAccess } from "../global-memory.js";

export const DREAMER_IDLE_TURNS = 10;
export const DREAMER_IDLE_MS = 10 * 60_000;

export interface DreamerSchedulerOptions {
  /** Borrow persisted messages only while reviewing this turn; do not clone or mutate them. */
  readTurn: (turnId: string) => Iterable<Message>;
  idleTurns?: number;
  idleMs?: number;
  maxRuntimeMs?: number;
  maxSteps?: number;
  protectedWritePaths?: readonly string[];
  toolPolicy?: HostToolPolicy;
  onEvent?: ExecutionEventSink;
}

/** Reviews accumulated turns after the Main agent has remained idle long enough. */
export class DreamerScheduler {
  private profile: AgentProfile | undefined;
  /** Settled turns that have not yet reached a review trigger. */
  private readonly waitingTurns: string[] = [];
  /** Triggered snapshot retained across partial completion and retries. */
  private readonly reviewBacklog: string[] = [];
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
  private readonly maxSteps: number;
  private readonly toolPolicy: HostToolPolicy | undefined;

  constructor(
    private readonly rootPath: string,
    private readonly memoryPath: string,
    profile: AgentProfile | undefined,
    private readonly options: DreamerSchedulerOptions,
  ) {
    this.profile = profile;
    this.idleTurns = options.idleTurns ?? DREAMER_IDLE_TURNS;
    this.idleMs = options.idleMs ?? DREAMER_IDLE_MS;
    this.maxRuntimeMs = options.maxRuntimeMs ?? DREAMER_MAX_RUNTIME_MS;
    this.maxSteps = options.maxSteps ?? DREAMER_MAX_STEPS;
    validateExecutionLimits({ maxSteps: this.maxSteps, timeoutMs: this.maxRuntimeMs });
    this.toolPolicy = options.toolPolicy;
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

  recordTurn(turnId: string): void {
    if (!this.enabled) return;
    this.waitingTurns.push(turnId);
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
    if (running) await running;
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
    turns: readonly string[],
    parentSignal: AbortSignal,
    onBatchReviewed: (turnCount: number) => void,
  ): Promise<void> {
    const timeout = AbortSignal.timeout(this.maxRuntimeMs);
    const signal = AbortSignal.any([parentSignal, timeout]);
    const batches = createDreamerReviewBatches(this.memoryPath, turns, this.options.readTurn, profile.model.contextWindow, signal);
    const reasoning = profile.thinkingLevel === "off" ? undefined : profile.thinkingLevel;
    for await (const batch of batches) {
      signal.throwIfAborted();
      const toolRunner = new ToolCallExecutor(this.rootPath, profile.tools, new ExtensionEvents(), {
        acceptsImages: profile.model.acceptsImages === true,
        writableExternalPaths: [this.memoryPath],
        protectedWritePaths: this.options.protectedWritePaths ?? [],
        globalMemory: new GlobalMemoryAccess(this.memoryPath, true),
        ...(this.toolPolicy ? { toolPolicy: this.toolPolicy } : {}),
        agentId: profile.id,
      });
      const runner = new AgentStepRunner(profile.model, toolRunner, reasoning);
      const journal = new EphemeralAgentJournal([batch.message], profile.id);
      const ui = executionEventSink(journal.identity, this.options.onEvent);
      let output = "";
      let error: unknown;
      safeExecutionEvent(ui, { type: "agent_run_started", input: contentText(batch.message.content, "") });
      try {
        for (let step = 1; ; step++) {
          signal.throwIfAborted();
          const result = await runner.run({
            systemPrompt: profile.systemPrompt,
            messages: journal.conversationMessages(),
            tools: profile.tools.modelDefinitions(),
          }, journal, { signal, step, onExecutionEvent: ui });
          output = contentText(result.response.content, "");
          if (runner.isContextOverflow(result.response)) {
            throw new Error("Dreamer context exhausted; use narrower memory reads or a model with a larger context window");
          }
          assertModelStepSucceeded(result, signal);
          if (result.calls.length === 0) break;
          if (step >= this.maxSteps) throw new Error(`Dreamer exceeded ${this.maxSteps} model steps per review batch`);
        }
        signal.throwIfAborted();
        onBatchReviewed(batch.turnCount);
      } catch (cause) {
        error = cause;
        throw cause;
      } finally {
        safeExecutionEvent(ui, { type: "agent_run_finished", output,
          outcome: signal.aborted ? "cancelled" : error !== undefined ? "failed" : "completed",
          ...(error !== undefined ? { error: String(error instanceof Error ? error.message : error) } : {}),
        });
      }
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
