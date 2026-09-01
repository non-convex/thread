import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { BuiltContext } from "../context/builder.js";
import type { CompactionResult } from "../context/compaction.js";
import type { ExtensionEvents } from "../extensions/events.js";
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
    const workspaceCapture = this.workspace.captureStaged();
    void workspaceCapture.catch(() => undefined);
    let preparedContext: BuiltContext;
    try {
      preparedContext = await this.runner.prepareCurrent();
      options.signal.throwIfAborted();
    } catch (cause) {
      const unused = await workspaceCapture.catch(() => undefined);
      await unused?.persisted.catch(() => undefined);
      throw cause;
    }
    const turnReady = workspaceCapture.then((capture) => this.tree.startPlannedTurn(
      planned,
      capture.state.id,
      capture.persisted,
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
    const turn = await turnReady;
    const settled = await this.tree.finishTurn(turn.id, outcome, error);
    await this.extensions.emit("turn_end", { turnId: turn.id, outcome }).catch(() => undefined);
    safeUiEvent(options.onUiEvent, {
      type: "turn_finished",
      outcome,
      ...(error ? { error: error.message } : {}),
    });
    if (outcome === "completed") {
      safeUiEvent(options.onUiEvent, {
        type: "session_changed",
        sessionId: settled.sessionId,
        liveTipTurnId: settled.id,
        reason: "turn",
      });
    }
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
