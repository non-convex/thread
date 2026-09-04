// Compaction orchestration: plan, summarize, verify, append one Session Tree entry.

import type { Context, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelClient } from "../../agent/model-client.js";
import type { CompactionReason } from "../../session-tree/model.js";
import type { SessionTreeService } from "../../session-tree/service.js";
import { projectedContextMessages, type BuiltContext } from "../builder.js";
import { contextBudget } from "../budget.js";
import { generateHistorySummary } from "./history-summary.js";
import { minimumUsefulSavings } from "./policy.js";
import { prepareCompaction } from "./prepare.js";
import { generateProgressSummary } from "./progress-summary.js";
import { historySummaryContext, progressSummaryContext, replacementContext } from "./slice.js";

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
    systemTokens: number;
    tokensBefore: number;
    appendAfter?: Promise<unknown>;
  }): Promise<CompactionResult> {
    const newestTurn = options.built.compactableTurns.at(-1);
    if (newestTurn && newestTurn.turnId !== options.turnId) {
      throw new Error(`Compaction target ${options.turnId} is not the newest context projection`);
    }

    const plan = prepareCompaction(options.built, options.systemTokens);
    if (!plan) return { compacted: false };

    const compactedAt = Date.now();
    const previousProgressSummary = options.built.latestCompaction?.progressSummary;

    const historySummary = await generateHistorySummary({
      model: this.model,
      context: historySummaryContext(options.context, options.built.messages, plan.summarizedUnits),
      signal: options.signal,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    });
    // A partial-turn checkpoint needs the freshly generated history document as
    // background, so unlike the old implementation this request runs second.
    const progressSummary = plan.partialTurnTrajectory
      ? await generateProgressSummary({
          model: this.model,
          context: progressSummaryContext(historySummary, plan.partialTurnTrajectory),
          signal: options.signal,
          ...(previousProgressSummary ? { previousSummary: previousProgressSummary } : {}),
          ...(this.reasoning ? { reasoning: this.reasoning } : {}),
        })
      : undefined;

    // Measured through the same projection the builder replays on every later
    // request, so the verified saving cannot drift from the real prompt.
    const projectedMessages = projectedContextMessages(
      historySummary,
      plan.retainedTurns,
      compactedAt,
      progressSummary,
    );
    const projected = replacementContext(options.built.messages, options.context, projectedMessages);
    const tokensAfter = contextBudget(projected, projectedMessages, this.model.maxOutputTokens).requestTokens;
    if (options.tokensBefore - tokensAfter < minimumUsefulSavings(options.tokensBefore)) {
      return { compacted: false };
    }

    options.signal.throwIfAborted();
    await options.appendAfter;
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
