/*
 * Context-estimation logic in this file is derived from earendil-works/pi.
 * Copyright (c) 2025 Mario Zechner. Licensed under the MIT License.
 * See the external-project attribution in README.md.
 */
import type { AssistantMessage, Context, ImageContent, Message, TextContent, Tool, Usage } from "@earendil-works/pi-ai";
import { COMPACTION_SUMMARY_PREFIX } from "../context/builder.js";

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

/**
 * Bumped when a recorded percent changes meaning. v2 counts the system prompt and
 * tool schemas, so its numbers are not comparable with a v1 record.
 */
export const CONTEXT_ESTIMATOR_VERSION = "pi-ai-estimate-v2";

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
 * Prompt-cache TTL: an idle gap longer than this is the likely cause of a miss.
 * Anthropic's default ephemeral cache expires after five minutes.
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** Per-turn misses at or below this are cache-breakpoint granularity noise. */
const CACHE_MISS_NOISE_FLOOR_TOKENS = 1024;

/** One counted cache miss, attributed to the request that paid for it. */
export interface CacheMiss {
  /** Prompt tokens that were in the previous request's prompt but not read from cache. */
  missedTokens: number;
  /** Extra cost versus a full cache hit; 0 when the provider reports no pricing. */
  missedCost: number;
  /** Milliseconds since the previous request, which last refreshed the cache. */
  idleMs: number;
  /** True when this request used a different model than the previous one. */
  modelChanged: boolean;
}

export interface CacheWasteTotals {
  missedTokens: number;
  missedCost: number;
  /** Number of counted misses; turns below the noise floor are excluded. */
  missCount: number;
}

/** The last request seen while scanning; everything in its prompt should still be cached. */
interface PreviousRequest {
  promptTokens: number;
  modelKey: string;
  timestamp: number;
  /**
   * Sticky: some earlier request in this segment reported cache activity. Tells a
   * total miss on a read-only reporting provider (OpenAI-style, writes unreported)
   * apart from a provider that never reports caching at all.
   */
  reportedCache: boolean;
}

function assistantModelKey(message: AssistantMessage): string {
  const provider = (message as AssistantMessage & { provider?: string }).provider ?? "";
  const model = (message as AssistantMessage & { model?: string }).model ?? "";
  return `${provider}/${model}`;
}

/**
 * Count what one request re-paid for relative to the previous one. Returns
 * undefined when nothing is counted: the first request, right after a prefix
 * rewrite, a provider that never reports caching, or a miss small enough to be
 * breakpoint granularity.
 */
function detectMiss(previous: PreviousRequest | undefined, message: AssistantMessage): CacheMiss | undefined {
  const usage = message.usage;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (!previous || promptTokens <= 0) return undefined;
  if (usage.cacheRead + usage.cacheWrite === 0 && !previous.reportedCache) return undefined;

  const missedTokens = Math.min(previous.promptTokens, promptTokens) - usage.cacheRead;
  if (missedTokens <= CACHE_MISS_NOISE_FLOOR_TOKENS) return undefined;

  /* Missed tokens can only land in the input or cacheWrite buckets, so this
   * request's own cost breakdown gives the rate actually paid; the counterfactual
   * is the same tokens billed at its cache-read rate. */
  const paidTokens = usage.input + usage.cacheWrite;
  const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
  const readPerToken = usage.cacheRead > 0 ? usage.cost.cacheRead / usage.cacheRead : 0;
  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
    idleMs: Math.max(0, message.timestamp - previous.timestamp),
    modelChanged: assistantModelKey(message) !== previous.modelKey,
  };
}

function asPreviousRequest(message: AssistantMessage, reportedCache: boolean): PreviousRequest | undefined {
  const usage = message.usage;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (promptTokens <= 0) return undefined;
  return {
    promptTokens,
    modelKey: assistantModelKey(message),
    timestamp: message.timestamp,
    reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
  };
}

export interface CacheScan {
  totals: CacheWasteTotals;
  /** Counted misses keyed by the assistant message that paid for them. */
  misses: Map<AssistantMessage, CacheMiss>;
  /** Hit ratio over the segment after the newest prefix rewrite. */
  hitTotals: CacheHitTotals;
}

/**
 * Walk a built context and attribute prompt-cache waste turn by turn. A compaction
 * message legitimately rewrites the prefix, so the comparison resets there
 * instead of blaming the next request; a model switch does not reset, because it
 * really does re-bill the whole prompt. Aborted and failed responses still count:
 * their prompt was paid for.
 */
export function scanCacheUsage(messages: readonly Message[]): CacheScan {
  let previous: PreviousRequest | undefined;
  const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0 };
  const misses = new Map<AssistantMessage, CacheMiss>();
  let hitTotals: CacheHitTotals = { cacheRead: 0, missed: 0 };

  for (const message of messages) {
    if (message.role === "user" && isPrefixRewrite(message)) {
      previous = undefined;
      hitTotals = { cacheRead: 0, missed: 0 };
      continue;
    }
    if (message.role !== "assistant") continue;
    const assistant = message as AssistantMessage;
    if (assistant.usage.totalTokens <= 0 && assistant.usage.input <= 0) continue;
    const miss = detectMiss(previous, assistant);
    if (miss) {
      totals.missedTokens += miss.missedTokens;
      totals.missedCost += miss.missedCost;
      totals.missCount += 1;
      misses.set(assistant, miss);
    }
    const hits = cacheHitTotals(assistant.usage);
    hitTotals.cacheRead += hits.cacheRead;
    hitTotals.missed += hits.missed;
    previous = asPreviousRequest(assistant, previous?.reportedCache ?? false) ?? previous;
  }
  return { totals, misses, hitTotals };
}

/**
 * A compaction summary is injected as a user message ahead of the retained turn suffix, so
 * the prefix it replaces is gone and the next request cannot reuse it.
 */
function isPrefixRewrite(message: Message): boolean {
  const content = message.content;
  const text = typeof content === "string"
    ? content
    : content.map((block) => (block.type === "text" ? block.text : "")).join("");
  return text.startsWith(COMPACTION_SUMMARY_PREFIX);
}

/**
 * Sum cache totals across a context. Numerator and denominator accumulate
 * separately: averaging each response's percentage would weight a tiny early
 * request the same as a full-window one. The first request of a context, and the
 * first after compaction rewrites the prefix, legitimately report no hits.
 */
export function accumulateCacheHits(messages: readonly Message[]): CacheHitTotals {
  return scanCacheUsage(messages).hitTotals;
}

/**
 * Why the newest counted miss happened, for a one-glance footer hint. Idle
 * expiry is checked first: when a turn is both late and on a new model, the TTL
 * had already dropped the prefix before the switch could matter.
 */
export function latestCacheMissReason(
  messages: readonly Message[],
  scan: CacheScan = scanCacheUsage(messages),
): "idle" | "model-changed" | "prefix-changed" | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const miss = scan.misses.get(message as AssistantMessage);
    if (!miss) return null;
    if (miss.idleMs > CACHE_TTL_MS) return "idle";
    if (miss.modelChanged) return "model-changed";
    return "prefix-changed";
  }
  return null;
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
