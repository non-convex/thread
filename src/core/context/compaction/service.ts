import type { ExecutionEventSink } from "../../runtime/events.js";
// Compaction orchestration: plan, summarize, verify, append one Session Tree entry.

import type { Context, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelClient } from "../../agent/model-client.js";
import type { CompactionReason } from "../../session-tree/model.js";
import type { SessionTreeService } from "../../session-tree/service.js";
import { messagesForModel } from "../../session-tree/user-content.js";
import { projectedContextMessages, type BuiltContext } from "../builder.js";
import { contextBudget } from "../budget.js";
import { generateHistorySummary } from "./history-summary.js";
import { minimumUsefulSavings } from "./policy.js";
import { prepareCompaction } from "./prepare.js";
import { generateProgressSummary } from "./progress-summary.js";
import { collectProgressBackground, historySummaryContext, progressSummaryContext, replacementContext } from "./slice.js";

export type CompactionResult =
  | { compacted: false }
  | {
      compacted: true;
      entryId: string;
      historySummary: string;
      progressSummary?: string;
      summarizedSteps: number;
      retainedSteps: number;
      tokensBefore: number;
      tokensAfter: number;
    };

export class ContextCompactionService {
  constructor(
    private readonly tree: SessionTreeService,
    private readonly model: ModelClient,
    private readonly reasoning?: ThinkingLevel,
  ) {}

  needsCompaction(built: BuiltContext, systemTokens: number, targetTurnId: string): boolean {
    return (
      built.compactableTurns.at(-1)?.turnId === targetTurnId &&
      prepareCompaction(built, systemTokens) !== undefined
    );
  }

  async compact(options: {
    built: BuiltContext;
    context: Context;
    turnId: string;
    reason: CompactionReason;
    signal: AbortSignal;
    onExecutionEvent?: ExecutionEventSink;
    systemTokens: number;
    tokensBefore: number;
  }): Promise<CompactionResult> {
    const newestTurn = options.built.compactableTurns.at(-1);
    if (newestTurn && newestTurn.turnId !== options.turnId) {
      throw new Error(`Compaction target ${options.turnId} is not the newest context projection`);
    }

    const plan = prepareCompaction(options.built, options.systemTokens);
    if (!plan) return { compacted: false };

    const compactedAt = Date.now();
    const previousCompaction = options.built.latestCompaction;
    // A checkpoint belongs to the first retained turn, not necessarily the turn
    // where its compaction entry was recorded.
    const previousProgressSummary =
      previousCompaction?.retainedTurns[0]?.turnId === plan.retainedTurns[0]?.turnId
        ? previousCompaction?.progressSummary
        : undefined;

    // Match the same image projection used by the live request. The plan and
    // retained turns still reference raw Session Tree messages for persistence.
    const sessionMessages = messagesForModel(options.built.messages, this.model.acceptsImages);
    const historyContext = historySummaryContext(options.context, sessionMessages, plan.retainedUnits);
    const historyTask = generateHistorySummary({
      model: this.model,
      context: {
        ...historyContext,
        messages: messagesForModel(historyContext.messages, this.model.acceptsImages),
      },
      signal: options.signal,
      ...(options.onExecutionEvent ? { onExecutionEvent: options.onExecutionEvent } : {}),
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    });
    const progressContext = plan.partialTurnTrajectory && plan.partialTurnId
      ? progressSummaryContext(
          collectProgressBackground(options.built, plan.partialTurnId),
          plan.partialTurnTrajectory,
        )
      : undefined;
    const progressTask = progressContext
      ? generateProgressSummary({
          model: this.model,
          context: {
            ...progressContext,
            messages: messagesForModel(progressContext.messages, this.model.acceptsImages),
          },
          signal: options.signal,
          ...(options.onExecutionEvent ? { onExecutionEvent: options.onExecutionEvent } : {}),
          ...(previousProgressSummary ? { previousSummary: previousProgressSummary } : {}),
          ...(this.reasoning ? { reasoning: this.reasoning } : {}),
        })
      : Promise.resolve(undefined);
    const [history, progress] = await Promise.allSettled([historyTask, progressTask]);
    if (history.status === "rejected") throw history.reason;
    if (progress.status === "rejected") throw progress.reason;
    const historySummary = history.value;
    const progressSummary = progress.value;

    // Measured through the same projection the builder replays on every later
    // request, so the verified saving cannot drift from the real prompt.
    const projectedMessages = projectedContextMessages(
      historySummary,
      plan.retainedTurns,
      compactedAt,
      progressSummary,
    );
    const modelProjectedMessages = messagesForModel(projectedMessages, this.model.acceptsImages);
    const projected = replacementContext(sessionMessages, options.context, modelProjectedMessages);
    const tokensAfter = contextBudget(projected, projectedMessages).requestTokens;
    if (options.tokensBefore - tokensAfter < minimumUsefulSavings(options.tokensBefore)) {
      return { compacted: false };
    }

    options.signal.throwIfAborted();
    const entry = await this.tree.appendCompaction({
      turnId: options.turnId,
      summary: historySummary,
      retainedTurns: plan.retainedTurns,
      tokensBefore: options.tokensBefore,
      tokensAfter,
      reason: options.reason,
      ...(progressSummary ? { progressSummary } : {}),
    });
    return {
      compacted: true,
      entryId: entry.id,
      historySummary,
      ...(progressSummary ? { progressSummary } : {}),
      summarizedSteps: plan.summarizedUnits.filter((unit) => unit.kind === "step").length,
      retainedSteps: plan.retainedUnits.filter((unit) => unit.kind === "step").length,
      tokensBefore: options.tokensBefore,
      tokensAfter,
    };
  }
}
