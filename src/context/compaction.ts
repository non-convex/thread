import type { Context, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelClient } from "../agent/model-client.js";
import { COMPACTION_CACHE_FORMAT, ContextCache, pathFingerprint } from "./cache.js";
import type { ContextBuilder, ContextTurn } from "./builder.js";

const SUMMARY_INSTRUCTION = [
  "Compact the earlier conversation prefix into a concise project-state summary for a continuing coding agent.",
  "Preserve the active goal, user decisions and corrections, architectural constraints, implemented results,",
  "validation evidence, failed approaches and reasons, unresolved risks, and the exact next useful action.",
  "Do not copy raw logs, hidden reasoning, or routine tool output. Do not invent facts.",
  "The original Session Tree remains stored and searchable; this summary is only a removable context cache.",
  "Return only the summary body and do not request tools.",
].join(" ");

export interface CompactionResult {
  compacted: boolean;
  summarizedTurns?: number;
  retainedTurns?: number;
  summarizedMessages?: number;
}

export class ContextCompactionService {
  constructor(
    private readonly builder: ContextBuilder,
    private readonly cache: ContextCache,
    private readonly model: ModelClient,
    private readonly reasoning?: ThinkingLevel,
    private readonly retainTurns = 2,
  ) {}

  needsCompaction(turns: readonly ContextTurn[], existingThroughTurnId?: string): boolean {
    const completed = turns.filter((turn) => turn.status === "completed");
    if (completed.length <= this.retainTurns) return false;
    const nextThrough = completed[completed.length - this.retainTurns - 1]!.id;
    return nextThrough !== existingThroughTurnId;
  }

  async compact(options: {
    turns: readonly ContextTurn[];
    fullContext: Context;
    signal: AbortSignal;
    maxTokens?: number;
  }): Promise<CompactionResult> {
    const completedPrefix = options.turns.filter((turn) => turn.status === "completed");
    if (completedPrefix.length <= this.retainTurns) return { compacted: false };
    const boundary = completedPrefix.length - this.retainTurns;
    const through = completedPrefix[boundary - 1]!;
    const throughIndex = options.turns.findIndex((turn) => turn.id === through.id);
    if (throughIndex < 0) throw new Error("Compaction boundary is not on the current path");
    const summarizedTurns = options.turns.slice(0, throughIndex + 1);
    const retainedTurns = options.turns.slice(throughIndex + 1);
    const summarizedMessages = this.builder.rawMessages(summarizedTurns);
    const promptContext: Context = options.fullContext;
    const maxTokens = Math.min(options.maxTokens ?? 4_000, this.model.maxOutputTokens);
    const instruction = [
      SUMMARY_INSTRUCTION,
      `The newest ${retainedTurns.length} turn(s) remain verbatim after this summary.`,
      "Do not summarize or duplicate those retained turns; summarize only the material before their boundary.",
    ].join(" ");
    const summary = await this.model.forkComplete(promptContext, instruction, {
      signal: options.signal,
      maxTokens,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    });
    if (!summary.trim()) throw new Error("Compaction produced an empty summary");
    const sessionId = through.sessionId;
    await this.cache.write({
      format: COMPACTION_CACHE_FORMAT,
      formatVersion: 1,
      sessionId,
      throughTurnId: through.id,
      pathFingerprint: pathFingerprint(summarizedTurns.map((turn) => turn.id)),
      summary: summary.trim(),
      createdAt: Date.now(),
    });
    return {
      compacted: true,
      summarizedTurns: summarizedTurns.length,
      retainedTurns: retainedTurns.length,
      summarizedMessages: summarizedMessages.length,
    };
  }
}
