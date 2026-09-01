import {
  contentText,
  type Context,
  type Message,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ModelClient } from "../agent/model-client.js";
import type { CompactionReason, RetainedTurn } from "../session-tree/model.js";
import type { SessionTreeService } from "../session-tree/service.js";
import { estimateMessageTokens } from "../utils/estimate.js";
import type { BuiltContext } from "./builder.js";

const SUMMARY_INSTRUCTION = `Create a concise project-state checkpoint from all preceding messages.

Do not continue the conversation, answer its questions, or call tools. Return only the checkpoint. If a previous derived checkpoint is present, preserve its still-valid information, incorporate subsequent progress and decisions, remove resolved blockers, and update next steps.

Use this structure:

## Goal
## Constraints and preferences
## Progress
### Done
### In progress
### Blocked
## Key decisions
## Next steps
## Critical context

Preserve exact paths, identifiers, commands, errors, user corrections, validation evidence, failed approaches and their reasons. Do not invent facts or copy routine logs.`;

export const COMPACTION_TARGET_TOKENS = 20_000;
export const COMPACTION_SUMMARY_RESERVE_TOKENS = 4_000;
export const COMPACTION_MIN_RETAINED_TURNS = 2;

export type CompactionResult =
  | { compacted: false }
  | {
      compacted: true;
      entryId: string;
      summarizedTurns: number;
      retainedTurns: number;
      tokensBefore: number;
    };

interface CompactionPreparation {
  summarizedTurnCount: number;
  summarizedMessageCount: number;
  retainedTurns: RetainedTurn[];
}

function turnTokens(turn: RetainedTurn): number {
  return turn.messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

// A trigger may fire between model steps, but the cut itself only moves across
// RetainedTurn values. The newest value can be an unfinished active turn; it is
// kept whole together with at least one preceding turn.
function retainedStartIndex(
  turns: readonly RetainedTurn[],
  systemTokens: number,
): number | undefined {
  if (turns.length <= COMPACTION_MIN_RETAINED_TURNS) return undefined;
  const retainedBudget = Math.max(
    0,
    COMPACTION_TARGET_TOKENS - COMPACTION_SUMMARY_RESERVE_TOKENS - systemTokens,
  );
  let retainedStart = turns.length - COMPACTION_MIN_RETAINED_TURNS;
  let retainedTokens = turns.slice(retainedStart).reduce((total, turn) => total + turnTokens(turn), 0);

  for (let index = retainedStart - 1; index >= 0; index--) {
    const nextTokens = turnTokens(turns[index]!);
    if (retainedTokens + nextTokens > retainedBudget) break;
    retainedStart = index;
    retainedTokens += nextTokens;
  }
  return retainedStart === 0 ? undefined : retainedStart;
}

function prepareCompaction(
  turns: readonly RetainedTurn[],
  systemTokens: number,
): CompactionPreparation | undefined {
  const retainedStart = retainedStartIndex(turns, systemTokens);
  if (retainedStart === undefined) return undefined;
  return {
    summarizedTurnCount: retainedStart,
    summarizedMessageCount: turns
      .slice(0, retainedStart)
      .reduce((total, turn) => total + turn.messages.length, 0),
    retainedTurns: structuredClone(turns.slice(retainedStart)),
  };
}

function messageFingerprint(message: Message): string {
  try {
    const serialized = JSON.stringify(message);
    if (serialized === undefined) throw new Error();
    return serialized;
  } catch {
    throw new Error("Session message cannot be compared after before_context transformation");
  }
}

function locateSessionMessages(contextMessages: readonly Message[], sessionMessages: readonly Message[]): number {
  if (contextMessages === sessionMessages) return 0;
  const contextFingerprints = contextMessages.map(messageFingerprint);
  const sessionFingerprints = sessionMessages.map(messageFingerprint);
  const matches: number[] = [];

  for (let start = 0; start <= contextMessages.length - sessionMessages.length; start++) {
    if (sessionFingerprints.every((fingerprint, offset) => contextFingerprints[start + offset] === fingerprint)) {
      matches.push(start);
    }
  }
  if (matches.length === 1) return matches[0]!;
  throw new Error(
    "before_context must preserve Session Tree messages as one contiguous sequence for cache-preserving compaction",
  );
}

function compactionContext(
  built: BuiltContext,
  context: Context,
  summarizedMessageCount: number,
): Context {
  const previousSummaryCount = built.latestCompaction ? 1 : 0;
  const expectedSessionMessages = previousSummaryCount + built.compactableTurns
    .reduce((total, turn) => total + turn.messages.length, 0);
  if (built.messages.length !== expectedSessionMessages) {
    throw new Error("Built context does not match its full-turn compaction projection");
  }
  const sessionStart = locateSessionMessages(context.messages, built.messages);
  const boundary = sessionStart + previousSummaryCount + summarizedMessageCount;
  return {
    ...context,
    messages: [
      ...context.messages.slice(0, boundary),
      { role: "user", content: SUMMARY_INSTRUCTION, timestamp: Date.now() },
    ],
  };
}

export class ContextCompactionService {
  constructor(
    private readonly tree: SessionTreeService,
    private readonly model: ModelClient,
    private readonly reasoning?: ThinkingLevel,
  ) {}

  needsCompaction(built: BuiltContext, systemTokens: number, targetTurnId: string): boolean {
    return built.compactableTurns.at(-1)?.turnId === targetTurnId &&
      retainedStartIndex(built.compactableTurns, systemTokens) !== undefined;
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
      throw new Error(`Compaction target ${options.turnId} is not the newest full-turn boundary`);
    }
    const preparation = prepareCompaction(options.built.compactableTurns, options.systemTokens);
    if (!preparation) return { compacted: false };

    const maxTokens = Math.min(COMPACTION_SUMMARY_RESERVE_TOKENS, this.model.maxOutputTokens);
    const response = await this.model.stream(
      compactionContext(options.built, options.context, preparation.summarizedMessageCount),
      {
        signal: options.signal,
        maxTokens,
        ...(this.reasoning ? { reasoning: this.reasoning } : {}),
      },
    );
    if (response.stopReason === "aborted") {
      throw new DOMException(response.errorMessage ?? "Compaction aborted", "AbortError");
    }
    if (response.stopReason === "error") {
      throw new Error(response.errorMessage ?? "Compaction model request failed");
    }
    if (response.stopReason === "toolUse" || response.content.some((block) => block.type === "toolCall")) {
      throw new Error("Compaction model attempted to call a tool");
    }
    const summary = contentText(response.content, "").trim();
    if (!summary) throw new Error("Compaction produced an empty summary");

    options.signal.throwIfAborted();
    await options.appendAfter;
    const entry = await this.tree.appendCompaction({
      turnId: options.turnId,
      summary,
      retainedTurns: preparation.retainedTurns,
      tokensBefore: options.tokensBefore,
      reason: options.reason,
    });
    return {
      compacted: true,
      entryId: entry.id,
      summarizedTurns: preparation.summarizedTurnCount,
      retainedTurns: preparation.retainedTurns.length,
      tokensBefore: options.tokensBefore,
    };
  }
}
