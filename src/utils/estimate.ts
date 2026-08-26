/*
 * Context-estimation logic in this file is derived from earendil-works/pi.
 * Copyright (c) 2025 Mario Zechner. Licensed under the MIT License.
 * See the external-project attribution in README.md.
 */
import type { AssistantMessage, Context, ImageContent, Message, TextContent, Tool, Usage } from "@earendil-works/pi-ai";

export interface ContextUsageEstimate {
  /** Estimated total context tokens. */
  tokens: number;
  /** Tokens reported by the most recent applicable assistant usage block. */
  usageTokens: number;
  /** Estimated tokens after the most recent applicable assistant usage block. */
  trailingTokens: number;
  /** Index of the applicable message that provided usage, or null when none exists. */
  lastUsageIndex: number | null;
}

export const CONTEXT_ESTIMATOR_VERSION = "pi-ai-estimate-v1";

const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;

export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export interface CacheHitTotals {
  /** Prompt tokens served from the provider's cache. */
  cacheRead: number;
  /** Prompt tokens billed as a cache write plus those that missed entirely. */
  missed: number;
}

/**
 * Cache hit rate covers the prompt side only: output tokens are generated fresh
 * every call, so `totalTokens` must never be the denominator. `cacheWrite` counts
 * as a miss because writing a prefix means it was not reused this call; providers
 * that do not report writes leave it at zero and the ratio still holds.
 */
export function cacheHitTotals(usage: Usage): CacheHitTotals {
  return { cacheRead: usage.cacheRead, missed: usage.input + usage.cacheWrite };
}

export function cacheHitPercent(totals: CacheHitTotals): number | null {
  const prompt = totals.cacheRead + totals.missed;
  if (prompt <= 0) return null;
  return Math.round((totals.cacheRead / prompt) * 100);
}

/**
 * Sum cache totals across a context. Numerator and denominator accumulate
 * separately: averaging each response's percentage would weight a tiny early
 * request the same as a full-window one. The first request of a context, and the
 * first after a squash rewrites the prefix, legitimately report no hits.
 */
export function accumulateCacheHits(messages: readonly Message[]): CacheHitTotals {
  const totals: CacheHitTotals = { cacheRead: 0, missed: 0 };
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const assistant = message as AssistantMessage;
    if (assistant.stopReason === "aborted" || assistant.stopReason === "error") continue;
    const usage = cacheHitTotals(assistant.usage);
    totals.cacheRead += usage.cacheRead;
    totals.missed += usage.missed;
  }
  return totals;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function estimateTextAndImageContentChars(content: string | Array<TextContent | ImageContent>): number {
  if (typeof content === "string") return content.length;

  let chars = 0;
  for (const block of content) chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
  return chars;
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
  return Math.ceil(estimateTextAndImageContentChars(content) / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: Message): number {
  let chars = 0;

  if (message.role === "user") return estimateTextAndImageContentTokens(message.content);
  if (message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);

  for (const block of message.content) {
    if (block.type === "text") {
      chars += block.text.length;
    } else if (block.type === "thinking") {
      chars += block.thinking.length;
    } else {
      chars += block.name.length + safeJsonStringify(block.arguments).length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function getLastAssistantUsageInfo(messages: readonly Message[]): { usage: Usage; index: number } | undefined {
  let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
  let usageInfo: { usage: Usage; index: number } | undefined;

  messages.forEach((message, i) => {
    if (message.role === "assistant") {
      const assistant = message as AssistantMessage;
      // A newer prefix message was inserted after this response (for example, a
      // compaction summary), so its usage cannot describe the current prefix.
      const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
      if (
        usageAppliesToPrefix &&
        assistant.stopReason !== "aborted" &&
        assistant.stopReason !== "error" &&
        calculateContextTokens(assistant.usage) > 0
      ) {
        usageInfo = { usage: assistant.usage, index: i };
      }
    }
    latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
  });

  return usageInfo;
}

function estimateMessages(messages: readonly Message[]): ContextUsageEstimate {
  const usageInfo = getLastAssistantUsageInfo(messages);
  if (usageInfo) {
    const usageTokens = calculateContextTokens(usageInfo.usage);
    let trailingTokens = 0;
    for (const message of messages.slice(usageInfo.index + 1)) {
      trailingTokens += estimateMessageTokens(message);
    }
    return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
  }

  let tokens = 0;
  for (const message of messages) tokens += estimateMessageTokens(message);
  return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

function estimateToolsTokens(tools: readonly Tool[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  return estimateTextTokens(safeJsonStringify(tools));
}

function isMessageArray(value: Context | readonly Message[]): value is readonly Message[] {
  return Array.isArray(value);
}

export function estimateContextTokens(context: Context | readonly Message[]): ContextUsageEstimate {
  if (isMessageArray(context)) return estimateMessages(context);

  const estimate = estimateMessages(context.messages);
  if (estimate.lastUsageIndex !== null) {
    const addedNames = new Set(
      context.messages
        .slice(estimate.lastUsageIndex + 1)
        .filter((message) => message.role === "toolResult")
        .flatMap((message) => message.addedToolNames ?? []),
    );
    const addedToolTokens = estimateToolsTokens(context.tools?.filter((tool) => addedNames.has(tool.name)));
    return {
      tokens: estimate.tokens + addedToolTokens,
      usageTokens: estimate.usageTokens,
      trailingTokens: estimate.trailingTokens + addedToolTokens,
      lastUsageIndex: estimate.lastUsageIndex,
    };
  }

  const prefixTokens =
    (context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0) + estimateToolsTokens(context.tools);

  return {
    tokens: estimate.tokens + prefixTokens,
    usageTokens: estimate.usageTokens,
    trailingTokens: estimate.trailingTokens + prefixTokens,
    lastUsageIndex: estimate.lastUsageIndex,
  };
}
