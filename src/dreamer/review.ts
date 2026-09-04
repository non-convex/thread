import type { Message } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "../context/usage.js";

const DREAMER_REVIEW_CONTEXT_RATIO = 0.5;
const TRACE_SEGMENT_CHAR_LIMIT = 1_000;
const TURN_SEPARATOR = "\n\n--- next turn ---\n\n";

export interface DreamerReviewBatch {
  message: Message;
  turnCount: number;
  estimatedTokens: number;
}

function textBlocks(content: Message["content"]): string {
  if (typeof content === "string") return content.trim();
  return (content as readonly { type: string; text?: string }[])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function abbreviated(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const marker = "\n... [content omitted] ...\n";
  const available = limit - marker.length;
  if (available <= 0) return text.slice(0, limit);
  const start = Math.ceil(available / 2);
  const end = Math.floor(available / 2);
  return `${text.slice(0, start)}${marker}${text.slice(text.length - end)}`;
}

function toolArguments(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, undefined, 2);
    return serialized === undefined ? "(no arguments)" : abbreviated(serialized, TRACE_SEGMENT_CHAR_LIMIT);
  } catch {
    return "(arguments could not be serialized)";
  }
}

/** Preserve the interaction and a bounded view of the agent's work trajectory. */
export function dreamerConversation(messages: readonly Message[]): string {
  const askCalls = new Set<string>();
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = textBlocks(message.content);
      if (text) lines.push(`[user]\n${text}`);
      continue;
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) {
          lines.push(`[assistant]\n${block.text.trim()}`);
        } else if (block.type === "thinking" && block.thinking.trim()) {
          lines.push(`[assistant reasoning]\n${abbreviated(block.thinking.trim(), TRACE_SEGMENT_CHAR_LIMIT)}`);
        } else if (block.type === "toolCall") {
          if (block.name === "ask") askCalls.add(block.id);
          lines.push(`[tool call: ${block.name}]\n${toolArguments(block.arguments)}`);
        }
      }
      continue;
    }
    if (message.role === "toolResult") {
      const text = textBlocks(message.content);
      if (!text) continue;
      if (message.toolName === "ask" || askCalls.has(message.toolCallId)) {
        lines.push(`[user answer via ask]\n${abbreviated(text, TRACE_SEGMENT_CHAR_LIMIT)}`);
      } else {
        const status = message.isError ? "error" : "success";
        lines.push(`[tool result: ${message.toolName} · ${status}]\n${abbreviated(text, TRACE_SEGMENT_CHAR_LIMIT)}`);
      }
    }
  }
  return lines.join("\n\n");
}

function turnContent(messages: readonly Message[], index: number): string {
  const conversation = dreamerConversation(messages) || "(no interaction or work trajectory)";
  return `[turn ${index + 1}]\n${conversation}`;
}

function reviewMessage(memoryPath: string, content: string, now: Date): Message {
  return {
    role: "user",
    timestamp: now.getTime(),
    content: `Global memory file: ${memoryPath}\nCurrent time: ${now.toISOString()}\n\nInteraction and work trajectory to review:\n\n${content}`,
  };
}

function makeBatch(memoryPath: string, turns: readonly string[], now: Date): DreamerReviewBatch {
  const message = reviewMessage(memoryPath, turns.join(TURN_SEPARATOR), now);
  return {
    message,
    turnCount: turns.length,
    estimatedTokens: estimateContextTokens([message]).tokens,
  };
}

function fitSingleTurn(memoryPath: string, content: string, maxTokens: number, now: Date): string {
  if (makeBatch(memoryPath, [content], now).estimatedTokens <= maxTokens) return content;

  let low = 1;
  let high = content.length;
  let best: string | undefined;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate = abbreviated(content, length);
    if (makeBatch(memoryPath, [candidate], now).estimatedTokens <= maxTokens) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  if (best !== undefined) return best;

  const placeholder = "[turn omitted because its review envelope exceeds half of the model context window]";
  if (makeBatch(memoryPath, [placeholder], now).estimatedTokens <= maxTokens) return placeholder;
  throw new Error("Dreamer model context window is too small for the review envelope");
}

/**
 * Keep one review request when the accumulated turns fit within half of the
 * model context window; otherwise split them into the largest complete-turn
 * batches that fit the same limit.
 */
export function createDreamerReviewBatches(
  memoryPath: string,
  turns: readonly (readonly Message[])[],
  contextWindow: number,
  now = new Date(),
): DreamerReviewBatch[] {
  if (turns.length === 0) return [];
  const maxTokens = Math.max(1, Math.floor(contextWindow * DREAMER_REVIEW_CONTEXT_RATIO));
  const contents = turns.map(turnContent);
  const combined = makeBatch(memoryPath, contents, now);
  if (combined.estimatedTokens <= maxTokens) return [combined];

  const fitted = contents.map((content) => fitSingleTurn(memoryPath, content, maxTokens, now));
  const batches: DreamerReviewBatch[] = [];
  let current: string[] = [];
  for (const content of fitted) {
    const candidate = makeBatch(memoryPath, [...current, content], now);
    if (current.length > 0 && candidate.estimatedTokens > maxTokens) {
      batches.push(makeBatch(memoryPath, current, now));
      current = [content];
    } else {
      current.push(content);
    }
  }
  if (current.length > 0) batches.push(makeBatch(memoryPath, current, now));
  return batches;
}
