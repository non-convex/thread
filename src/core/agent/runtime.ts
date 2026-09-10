import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { CompactionResult } from "../context/compaction/index.js";
import type { ExtensionEvents } from "../extensions/events.js";
import type { AgentTaskOrchestrator } from "../agent-task/orchestrator.js";
import type { Turn } from "../session-tree/model.js";
import type { SessionTreeService } from "../session-tree/service.js";
import { userContentDisplay } from "../session-tree/user-content.js";
import { runtimeEventSink, safeExecutionEvent, type ExecutionEventSink } from "../runtime/events.js";
import { executionDeadline, RuntimeLimitError, validateExecutionLimits, type RuntimeLimit } from "../runtime/limits.js";
import type { RunTurnOptions, TurnRunner } from "./turn-runner.js";

export interface TurnResult {
  turn: Turn;
  outcome: "completed" | "interrupted" | "failed";
  messages: AssistantMessage[];
  error?: Error;
  limit?: RuntimeLimit;
}

export class AgentRuntime {
  constructor(
    private readonly tree: SessionTreeService,
    private readonly runner: TurnRunner,
    private readonly extensions: ExtensionEvents,
    private readonly agentTasks?: AgentTaskOrchestrator,
    private readonly fileCheckpoints = true,
  ) {}

  async run(input: string, options: RunTurnOptions): Promise<TurnResult> {
    validateExecutionLimits(options);
    const deadline = executionDeadline(options.signal, options.timeoutMs);
    try {
      return await this.runWithDeadline(input, { ...options, signal: deadline.signal });
    } finally {
      deadline.dispose();
    }
  }

  private async runWithDeadline(input: string, options: RunTurnOptions): Promise<TurnResult> {
    this.tree.requireIdle();
    options.signal.throwIfAborted();
    const planned = this.tree.planTurn(input, options.images ?? [], options.sessionId, this.fileCheckpoints);
    options = this.withEvents(options, planned.sessionId, planned.id);
    const display = userContentDisplay(planned.content ?? planned.input);
    safeExecutionEvent(options.onUiEvent, {
      type: "turn_preparing",
      input: display,
      sessionId: planned.sessionId,
    });
    options.signal.throwIfAborted();
    // Admit the turn durably before extensions, model requests or tool effects.
    const turn = await this.tree.startPlannedTurn(planned);
    safeExecutionEvent(options.onUiEvent, {
      type: "turn_started",
      turnId: turn.id,
      userEntryId: turn.userEntryId,
      input: display,
      sessionId: turn.sessionId,
    });
    const messages: AssistantMessage[] = [];
    let error: Error | undefined;
    let outcome: TurnResult["outcome"] = "completed";
    try {
      options.signal.throwIfAborted();
      await this.extensions.emit("turn_start", { turnId: turn.id, sessionId: turn.sessionId, input: display });
      messages.push(...await this.runner.execute(turn, options));
      options.signal.throwIfAborted();
    } catch (cause) {
      const reason = options.signal.aborted ? options.signal.reason : cause;
      error = reason instanceof Error ? reason : new Error(String(reason));
      outcome = options.signal.aborted || error.name === "AbortError" || error instanceof RuntimeLimitError ? "interrupted" : "failed";
    }
    try {
      await this.agentTasks?.finishParentTurn(
        turn.id,
        outcome === "completed" ? "Parent turn ended" : `Parent turn ${outcome}`,
      );
    } catch (cause) {
      error ??= cause instanceof Error ? cause : new Error(String(cause));
      outcome = "failed";
    }
    if (outcome === "completed" && options.signal.aborted) {
      const reason = options.signal.reason;
      error = reason instanceof Error ? reason : new DOMException(String(reason ?? "Aborted"), "AbortError");
      outcome = "interrupted";
    }
    if (outcome !== "completed") {
      await this.tree.sealRunningTurn(turn.id, outcome, error);
    }
    const settled = await this.tree.finishTurn(turn.id, outcome, error);
    await this.extensions.emit("turn_end", { turnId: turn.id, outcome }).catch(() => undefined);
    safeExecutionEvent(options.onUiEvent, {
      type: "turn_finished",
      outcome,
      ...(outcome === "failed" && error ? { error: error.message } : {}),
      ...(error instanceof RuntimeLimitError ? { limit: error.limit } : {}),
    });
    safeExecutionEvent(options.onUiEvent, {
      type: "session_changed",
      sessionId: settled.sessionId,
      liveTipTurnId: settled.id,
      reason: "turn",
    });
    return {
      turn: settled, outcome, messages, ...(error ? { error } : {}),
      ...(error instanceof RuntimeLimitError ? { limit: error.limit } : {}),
    };
  }

  async compactCurrent(options: RunTurnOptions): Promise<CompactionResult> {
    validateExecutionLimits(options);
    const deadline = executionDeadline(options.signal, options.timeoutMs);
    const sessionId = options.sessionId ?? this.tree.activeSession.id;
    const turnId = this.tree.projection.liveTips.get(sessionId);
    try {
      const bounded = { ...options, signal: deadline.signal };
      return await this.runner.compactActive(turnId ? this.withEvents(bounded, sessionId, turnId) : bounded);
    } finally {
      deadline.dispose();
    }
  }

  private withEvents(options: RunTurnOptions, sessionId: string, turnId: string): RunTurnOptions {
    if (!options.onEvent && !options.onUiEvent) return options;
    const domain = runtimeEventSink({ sessionId, turnId }, options.onEvent);
    const onUiEvent: ExecutionEventSink = (event) => {
      domain(event);
      safeExecutionEvent(options.onUiEvent, event);
    };
    return { ...options, onUiEvent };
  }
}
