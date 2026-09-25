import type { Message } from "@earendil-works/pi-ai";
import { cooperativeYield } from "../utils/async.js";
import { jsonTextChunks } from "../utils/json-text.js";
import { estimateTextTokens } from "../context/usage.js";

const DREAMER_REVIEW_CONTEXT_RATIO = 0.5;
const TRACE_SEGMENT_CHAR_LIMIT = 1_000;
const TURN_SEPARATOR = "\n\n--- next turn ---\n\n";
const OMITTED = "\n... [content omitted] ...\n";

export interface DreamerReviewBatch {
  message: Message;
  turnCount: number;
  estimatedTokens: number;
}

/** Keep only the ends of a stream; never copy an unbounded message or turn. */
class BoundedText {
  private head = "";
  private tail = "";
  private length = 0;
  constructor(private readonly limit: number) {}
  append(text: string): void {
    this.appendRange(text, 0, text.length);
  }
  appendRange(text: string, start: number, end: number): void {
    const size = end - start;
    if (size <= 0) return;
    this.length += size;
    if (this.head.length < this.limit) this.head += text.slice(start, Math.min(end, start + this.limit - this.head.length));
    this.tail = (this.tail + text.slice(Math.max(start, end - this.limit), end)).slice(-this.limit);
  }
  get empty(): boolean { return this.length === 0; }
  value(): string {
    if (this.length <= this.limit) return this.head;
    if (this.limit <= OMITTED.length) return this.head.slice(0, this.limit);
    const available = this.limit - OMITTED.length;
    const tailSize = Math.floor(available / 2);
    return this.head.slice(0, Math.ceil(available / 2)) + OMITTED + (tailSize ? this.tail.slice(-tailSize) : "");
  }
}

async function appendTrimmed(to: BoundedText, text: string, signal: AbortSignal,
  maybeYield: (signal: AbortSignal) => Promise<void>): Promise<void> {
  let start = 0;
  let end = text.length;
  while (start < end && /\s/u.test(text[start]!)) {
    start++;
    if (start % (8 * 1024) === 0) await maybeYield(signal);
  }
  while (end > start && /\s/u.test(text[end - 1]!)) {
    end--;
    if (end % (8 * 1024) === 0) await maybeYield(signal);
  }
  to.appendRange(text, start, end);
}

async function toolArguments(value: unknown, signal: AbortSignal, maybeYield: (signal: AbortSignal) => Promise<void>): Promise<string> {
  try {
    if (value === undefined) return "(no arguments)";
    const text = new BoundedText(TRACE_SEGMENT_CHAR_LIMIT);
    for (const part of jsonTextChunks(value, 2)) {
      signal.throwIfAborted();
      text.append(part);
      await maybeYield(signal);
    }
    return text.value();
  } catch (error) {
    signal.throwIfAborted();
    return "(arguments could not be serialized)";
  }
}

async function conversation(messages: Iterable<Message>, limit: number, signal: AbortSignal): Promise<string> {
  const askCalls = new Set<string>();
  const result = new BoundedText(limit);
  const maybeYield = cooperativeYield();
  let first = true;
  const section = (heading: string, text: string) => {
    if (!text) return;
    if (!first) result.append("\n\n");
    first = false;
    result.append(heading);
    result.append(text);
  };
  const textBlocks = async (content: Message["content"], max: number): Promise<string> => {
    const text = new BoundedText(max);
    if (typeof content === "string") text.append(content);
    else {
      let firstBlock = true;
      for (const block of content) {
        if (block.type !== "text") continue;
        if (!firstBlock) text.append("\n");
        firstBlock = false;
        text.append(block.text);
        await maybeYield(signal);
      }
    }
    const trimmed = new BoundedText(max);
    await appendTrimmed(trimmed, text.value(), signal, maybeYield);
    return trimmed.value();
  };
  for (const message of messages) {
    signal.throwIfAborted();
    if (message.role === "user") {
      section("[user]\n", await textBlocks(message.content, limit));
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        signal.throwIfAborted();
        if (block.type === "text") {
          const text = new BoundedText(limit);
          await appendTrimmed(text, block.text, signal, maybeYield);
          section("[assistant]\n", text.value());
        } else if (block.type === "thinking") {
          const text = new BoundedText(TRACE_SEGMENT_CHAR_LIMIT);
          await appendTrimmed(text, block.thinking, signal, maybeYield);
          section("[assistant reasoning]\n", text.value());
        } else if (block.type === "toolCall") {
          if (block.name === "ask") askCalls.add(block.id);
          section(`[tool call: ${block.name}]\n`, await toolArguments(block.arguments, signal, maybeYield));
        }
        await maybeYield(signal);
      }
    } else if (message.role === "toolResult") {
      const text = await textBlocks(message.content, TRACE_SEGMENT_CHAR_LIMIT);
      if (message.toolName === "ask" || askCalls.has(message.toolCallId)) section("[user answer via ask]\n", text);
      else section(`[tool result: ${message.toolName} · ${message.isError ? "error" : "success"}]\n`, text);
    }
    await maybeYield(signal);
  }
  if (!result.empty) return result.value();
  const empty = new BoundedText(limit);
  empty.append("(no interaction or work trajectory)");
  return empty.value();
}

function reviewMessage(memoryPath: string, content: string, now: Date): Message {
  return {
    role: "user",
    timestamp: now.getTime(),
    content: `Global memory file: ${memoryPath}\nCurrent time: ${now.toISOString()}\n\nInteraction and work trajectory to review:\n\n${content}`,
  };
}

/** Read only the next turn when a batch needs it; yield completed batches before continuing. */
export async function* createDreamerReviewBatches(
  memoryPath: string,
  turnIds: readonly string[],
  readTurn: (turnId: string) => Iterable<Message>,
  contextWindow: number,
  signal: AbortSignal,
  now = new Date(),
): AsyncGenerator<DreamerReviewBatch> {
  const maxTokens = Math.max(1, Math.floor(contextWindow * DREAMER_REVIEW_CONTEXT_RATIO));
  const envelopeLength = (reviewMessage(memoryPath, "", now).content as string).length;
  const maxChars = maxTokens * 4 - envelopeLength;
  if (turnIds.length && maxChars < 1) throw new Error("Dreamer model context window is too small for the review envelope");
  const maybeYield = cooperativeYield();
  let current: string[] = [];
  let currentLength = 0;
  const batch = (): DreamerReviewBatch => {
    const message = reviewMessage(memoryPath, current.join(TURN_SEPARATOR), now);
    return { message, turnCount: current.length, estimatedTokens: estimateTextTokens(message.content as string) };
  };
  for (let index = 0; index < turnIds.length; index++) {
    signal.throwIfAborted();
    const heading = `[turn ${index + 1}]\n`;
    let content: string;
    try {
      if (maxChars < heading.length) throw new Error("Dreamer model context window is too small for the review envelope");
      content = heading + await conversation(readTurn(turnIds[index]!), maxChars - heading.length, signal);
    } catch (error) {
      // The already assembled batch can still succeed before the unread turn is retried.
      if (current.length && !signal.aborted) {
        yield batch();
        current = [];
      }
      throw error;
    }
    if (current.length && currentLength + TURN_SEPARATOR.length + content.length > maxChars) {
      yield batch();
      current = [];
      currentLength = 0;
    }
    current.push(content);
    currentLength += (current.length > 1 ? TURN_SEPARATOR.length : 0) + content.length;
    await maybeYield(signal);
  }
  if (current.length) {
    signal.throwIfAborted();
    yield batch();
  }
}
