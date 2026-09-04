import type { Message } from "@earendil-works/pi-ai";
import type { AgentProfile } from "../agent/profile.js";
import { EphemeralAgentJournal } from "../agent/ephemeral-journal.js";
import { AgentStepRunner } from "../agent/step-runner.js";
import { ToolCallExecutor } from "../agent/tool-call-executor.js";
import { ExtensionEvents } from "../extensions/events.js";
import { settlesWithin } from "../utils/async.js";
import {
  DREAMER_MAX_RUNTIME_MS,
  DREAMER_MAX_STEPS,
} from "./profile.js";

export const DREAMER_IDLE_TURNS = 10;
export const DREAMER_IDLE_MS = 10 * 60_000;
export const DREAMER_SHUTDOWN_GRACE_MS = 2_000;

function textBlocks(content: Message["content"]): string {
  if (typeof content === "string") return content.trim();
  return (content as readonly { type: string; text?: string }[])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

/** Keep only conversational evidence; ordinary tool traces are intentionally omitted. */
export function dreamerConversation(messages: readonly Message[]): string {
  const askCalls = new Set<string>();
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = textBlocks(message.content);
      if (text) lines.push(`[user]\n${text}`);
      continue;
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall" && block.name === "ask") askCalls.add(block.id);
      }
      const text = textBlocks(message.content);
      if (text) lines.push(`[assistant context]\n${text}`);
      continue;
    }
    if (message.role === "toolResult" && (message.toolName === "ask" || askCalls.has(message.toolCallId))) {
      const text = textBlocks(message.content);
      if (text) lines.push(`[explicit user answer via ask]\n${text}`);
    }
  }
  return lines.join("\n\n");
}

function reviewMessage(memoryPath: string, messages: readonly Message[]): Message {
  const conversation = dreamerConversation(messages) || "(no conversational text)";
  return {
    role: "user",
    timestamp: Date.now(),
    content: `Global memory file: ${memoryPath}\nCurrent time: ${new Date().toISOString()}\n\nConversation to review:\n\n${conversation}`,
  };
}

export interface DreamerSchedulerOptions {
  idleTurns?: number;
  idleMs?: number;
  maxSteps?: number;
  maxRuntimeMs?: number;
}

/** Coalesces deterministic triggers and runs Dreamer only while the foreground is idle. */
export class DreamerScheduler {
  private profile: AgentProfile | undefined;
  private readonly pending: Message[] = [];
  private settledTurns = 0;
  private immediate = false;
  private revision = 0;
  private immediateRevision = 0;
  private foregroundActive = false;
  private timer: NodeJS.Timeout | undefined;
  private controller: AbortController | undefined;
  private running: Promise<void> | undefined;
  private closing = false;
  private currentError: string | undefined;
  private readonly idleTurns: number;
  private readonly idleMs: number;
  private readonly maxSteps: number;
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
    this.maxSteps = options.maxSteps ?? DREAMER_MAX_STEPS;
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
      this.pending.splice(0);
      this.settledTurns = 0;
      this.immediate = false;
      this.immediateRevision = 0;
      return;
    }
    this.schedule();
  }

  recordTurn(messages: readonly Message[]): void {
    if (!this.enabled) return;
    this.pending.push(...messages.map((message) => structuredClone(message)));
    this.settledTurns += 1;
    this.revision += 1;
    this.schedule();
  }

  recordCompaction(messages: readonly Message[]): void {
    if (!this.enabled) return;
    this.pending.push(...messages.map((message) => structuredClone(message)));
    this.revision += 1;
    this.immediate = true;
    this.immediateRevision = this.revision;
    this.schedule();
  }

  async foregroundStarting(): Promise<void> {
    this.foregroundActive = true;
    this.clearTimer();
    if (!this.running) return;
    this.controller?.abort(new DOMException("Foreground input started", "AbortError"));
    await this.running.catch(() => undefined);
  }

  foregroundFinished(): void {
    this.foregroundActive = false;
    this.schedule();
  }

  async close(): Promise<void> {
    this.closing = true;
    this.clearTimer();
    this.controller?.abort(new DOMException("Thread application closed", "AbortError"));
    const running = this.running;
    if (running) await settlesWithin(running, DREAMER_SHUTDOWN_GRACE_MS);
    this.pending.splice(0);
    this.settledTurns = 0;
    this.immediate = false;
    this.immediateRevision = 0;
  }

  private schedule(): void {
    this.clearTimer();
    if (this.closing || this.foregroundActive || this.running || !this.profile || this.pending.length === 0) return;
    if (this.immediate) {
      this.timer = setTimeout(() => this.launch(), 0);
      return;
    }
    if (this.settledTurns >= this.idleTurns) {
      this.timer = setTimeout(() => this.launch(), this.idleMs);
    }
  }

  private launch(): void {
    this.timer = undefined;
    if (this.closing || this.foregroundActive || this.running || !this.profile || this.pending.length === 0) return;
    const profile = this.profile;
    const reviewedCount = this.pending.length;
    const reviewedTurns = this.settledTurns;
    const reviewedRevision = this.revision;
    const controller = new AbortController();
    this.controller = controller;
    const run = this.runProfile(profile, this.pending.slice(0, reviewedCount), controller.signal)
      .then(() => {
        this.pending.splice(0, reviewedCount);
        this.settledTurns = Math.max(0, this.settledTurns - reviewedTurns);
        if (this.immediateRevision <= reviewedRevision) {
          this.immediate = false;
          this.immediateRevision = 0;
        }
        this.currentError = undefined;
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (this.immediateRevision <= reviewedRevision) {
          this.immediate = false;
          this.immediateRevision = 0;
        }
        this.settledTurns = Math.max(this.settledTurns, this.idleTurns);
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

  private async runProfile(profile: AgentProfile, messages: readonly Message[], parentSignal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(this.maxRuntimeMs);
    const signal = AbortSignal.any([parentSignal, timeout]);
    const journal = new EphemeralAgentJournal([reviewMessage(this.memoryPath, messages)]);
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
    for (let step = 1; step <= this.maxSteps; step++) {
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
      if (result.calls.length === 0) return;
      if (step === this.maxSteps) throw new Error(`Dreamer exceeded ${this.maxSteps} model steps`);
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
