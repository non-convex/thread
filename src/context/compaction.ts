import {
  contentText,
  type Message,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ModelClient } from "../agent/model-client.js";
import type { CompactionReason, RetainedTurn } from "../session-tree/model.js";
import type { SessionTreeService } from "../session-tree/service.js";
import { createId } from "../utils/id.js";
import { estimateMessageTokens } from "../utils/estimate.js";
import type { BuiltContext } from "./builder.js";

const SUMMARY_SYSTEM_PROMPT = [
  "You are a context summarization assistant.",
  "Do not continue the conversation or answer its questions.",
  "Return only a structured checkpoint summary for another coding agent.",
].join(" ");

const SUMMARY_INSTRUCTION = `Create a concise project-state checkpoint from the conversation.

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

const UPDATE_INSTRUCTION = `Update the previous checkpoint using the new conversation.

Preserve still-valid information from the previous checkpoint, incorporate new progress and decisions, remove resolved blockers, and update next steps. Use the same structure as the previous checkpoint. Do not invent facts or continue the conversation.`;

const TOOL_RESULT_MAX_CHARS = 2_000;
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
  messagesToSummarize: Message[];
  retainedTurns: RetainedTurn[];
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

function serializeConversation(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = contentText(message.content, "");
      if (text) parts.push(`[User]: ${text}`);
      continue;
    }
    if (message.role === "toolResult") {
      const text = contentText(message.content, "");
      if (text) parts.push(`[Tool result]: ${truncate(text, TOOL_RESULT_MAX_CHARS)}`);
      continue;
    }
    const text = contentText(message.content, "");
    if (text) parts.push(`[Assistant]: ${text}`);
    const calls = message.content
      .filter((block) => block.type === "toolCall")
      .map((block) => block.type === "toolCall"
        ? `${block.name}(${safeJsonStringify(block.arguments)})`
        : "");
    if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
  }
  return parts.join("\n\n");
}

function turnTokens(turn: RetainedTurn): number {
  return turn.messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

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
    messagesToSummarize: turns.slice(0, retainedStart).flatMap((turn) => structuredClone(turn.messages)),
    retainedTurns: structuredClone(turns.slice(retainedStart)),
  };
}

export class ContextCompactionService {
  constructor(
    private readonly tree: SessionTreeService,
    private readonly model: ModelClient,
    private readonly reasoning?: ThinkingLevel,
  ) {}

  needsCompaction(built: BuiltContext, systemTokens: number): boolean {
    return retainedStartIndex(built.compactableTurns, systemTokens) !== undefined;
  }

  async compact(options: {
    built: BuiltContext;
    turnId: string;
    reason: CompactionReason;
    signal: AbortSignal;
    systemTokens: number;
    tokensBefore: number;
    appendAfter?: Promise<unknown>;
  }): Promise<CompactionResult> {
    const preparation = prepareCompaction(options.built.compactableTurns, options.systemTokens);
    if (!preparation) return { compacted: false };

    const conversation = serializeConversation(preparation.messagesToSummarize);
    const previousSummary = options.built.latestCompaction?.summary;
    const prompt = [
      `<conversation>\n${conversation}\n</conversation>`,
      ...(previousSummary ? [`<previous-summary>\n${previousSummary}\n</previous-summary>`] : []),
      previousSummary ? UPDATE_INSTRUCTION : SUMMARY_INSTRUCTION,
    ].join("\n\n");
    const maxTokens = Math.min(COMPACTION_SUMMARY_RESERVE_TOKENS, this.model.maxOutputTokens);
    const summary = await this.model.completeText(SUMMARY_SYSTEM_PROMPT, prompt, {
      signal: options.signal,
      maxTokens,
      cacheRetention: "none",
      sessionId: createId("compaction"),
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    });
    if (!summary.trim()) throw new Error("Compaction produced an empty summary");

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
