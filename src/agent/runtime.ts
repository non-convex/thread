import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { CompactionResult } from "../context/compaction/index.js";
import type { ExtensionEvents } from "../extensions/events.js";
import type { AgentTaskOrchestrator } from "../agent-task/orchestrator.js";
import type { Turn } from "../session-tree/model.js";
import type { SessionTreeService } from "../session-tree/service.js";
import type { WorkspaceStateService } from "../workspace-state/service.js";
import { safeUiEvent } from "../ui/events.js";
import type { RunTurnOptions, TurnRunner } from "./turn-runner.js";

export interface TurnResult {
  turn: Turn;
  outcome: "completed" | "interrupted" | "failed";
  messages: AssistantMessage[];
  error?: Error;
}

export type ManualCompactionResult = CompactionResult;

export class AgentRuntime {
  constructor(
    private readonly tree: SessionTreeService,
    private readonly workspace: WorkspaceStateService,
    private readonly runner: TurnRunner,
    private readonly extensions: ExtensionEvents,
    private readonly agentTasks?: AgentTaskOrchestrator,
  ) {}

  async run(input: string, options: RunTurnOptions): Promise<TurnResult> {
    this.tree.requireIdle();
    options.signal.throwIfAborted();
    const planned = this.tree.planTurn(input);
    safeUiEvent(options.onUiEvent, {
      type: "turn_preparing",
      input,
      sessionId: planned.sessionId,
    });
    const baseline = this.workspace.baseline();
    void baseline.catch(() => undefined);
    const preparedContext = await this.runner.prepareCurrent();
    options.signal.throwIfAborted();
    const turnReady = baseline.then((checkpoint) => this.tree.startPlannedTurn(
      planned,
      checkpoint.stateId,
      checkpoint.persisted,
    )).then((turn) => {
      safeUiEvent(options.onUiEvent, {
        type: "turn_started",
        turnId: turn.id,
        userEntryId: turn.userEntryId,
        input,
        sessionId: turn.sessionId,
      });
      return turn;
    });
    void turnReady.catch(() => undefined);
    const messages: AssistantMessage[] = [];
    let error: Error | undefined;
    let outcome: TurnResult["outcome"] = "completed";
    try {
      await this.extensions.emit("turn_start", { turnId: planned.id, sessionId: planned.sessionId, input });
      messages.push(...await this.runner.execute(planned, turnReady, options, preparedContext));
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error(String(cause));
      outcome = options.signal.aborted || error.name === "AbortError" ? "interrupted" : "failed";
    }
    try {
      await this.agentTasks?.finishParentTurn(
        planned.id,
        outcome === "completed" ? "Parent turn ended before this task was applied" : `Parent turn ${outcome}`,
        options.onUiEvent,
      );
    } catch (cause) {
      error ??= cause instanceof Error ? cause : new Error(String(cause));
      outcome = "failed";
    }
    const turn = await turnReady;
    if (outcome !== "completed") {
      await this.tree.sealRunningTurn(turn.id, outcome, error);
    }
    const settled = await this.tree.finishTurn(turn.id, outcome, error);
    safeUiEvent(options.onUiEvent, { type: "workspace_checkpoint_started" });
    await this.workspace.checkpoint();
    await this.extensions.emit("turn_end", { turnId: turn.id, outcome }).catch(() => undefined);
    safeUiEvent(options.onUiEvent, {
      type: "turn_finished",
      outcome,
      ...(outcome === "failed" && error ? { error: error.message } : {}),
    });
    safeUiEvent(options.onUiEvent, {
      type: "session_changed",
      sessionId: settled.sessionId,
      liveTipTurnId: settled.id,
      reason: "turn",
    });
    return { turn: settled, outcome, messages, ...(error ? { error } : {}) };
  }

  compactCurrent(options: RunTurnOptions): Promise<CompactionResult> {
    return this.runner.compactActive(options);
  }

  baseContextFor(messages: Message[]) {
    return this.runner.baseContextFor(messages);
  }

  estimateRequestBudget(messages: Message[]) {
    return this.runner.estimateRequestBudget(messages);
  }
}
