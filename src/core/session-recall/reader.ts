import type { Message } from "@earendil-works/pi-ai";
import type { SessionTreeService } from "../session-tree/service.js";
import type { SessionEntry, Turn } from "../session-tree/model.js";
import type { HistoryPathStatus, ReadOptions } from "./types.js";
import { cooperativeYield } from "../utils/async.js";
import { jsonTextChunks } from "../utils/json-text.js";

export function pathClassifier(tree: SessionTreeService, sessionId: string): (turn: Turn) => HistoryPathStatus {
  const current = new Set(tree.livePath(sessionId).map((turn) => turn.id));
  return (turn) => turn.sessionId !== sessionId ? "other-session"
    : current.has(turn.id) ? "current-path" : "current-session-off-path";
}

function resolveTurn(tree: SessionTreeService, id: string): Turn | undefined {
  const matches = [...tree.projection.turns.values()].filter((turn) => turn.id === id || turn.id.startsWith(id));
  if (matches.length > 1) throw new Error(`Turn prefix is ambiguous: ${id}`);
  return matches[0];
}

function* textBlocks(message: Message, thinking: boolean): Generator<string> {
  if (typeof message.content === "string") { yield message.content; return; }
  for (const block of message.content) {
    if (block.type === "text") yield block.text;
    else if (block.type === "image") yield "[image]";
    else if (block.type === "thinking" && thinking) yield block.thinking;
  }
}

function* joined(parts: Iterable<string>, separator: string): Generator<string> {
  let first = true;
  for (const part of parts) {
    if (!first) yield separator;
    first = false;
    yield part;
  }
}

export interface SessionTurnSegments {
  sessionId: string;
  turnId: string;
  startedAt: number;
  finishedAt?: number;
  status: Turn["status"];
  pathStatus: HistoryPathStatus;
  omitted: string[];
  /** Re-iterable view over original entries; no images or narrative strings are cloned. */
  text: Iterable<string>;
}

/** Format entries on demand, preserving narrative, ordinal order and omitted markers. */
function segmentsForTurn(classify: (turn: Turn) => HistoryPathStatus, turn: Turn, options: ReadOptions,
  entries: readonly SessionEntry[], length: number, omitted: string[], executed: ReadonlySet<string>): SessionTurnSegments {
  function* sections(): Generator<Iterable<string>> {
    for (let i = 0; i < length; i++) {
      const entry: SessionEntry = entries[i]!;
      if (entry.type === "compaction" || entry.type === "file_edit") continue;
      if (entry.type === "tool_execution") {
        if (options.toolCalls) yield (function* () {
          yield `[tool call ${entry.toolName}] `;
          yield* jsonTextChunks(entry.effectiveArgs);
        })();
        continue;
      }
      const message = entry.message;
      if (message.role === "toolResult") {
        if (options.toolResults) yield (function* () {
          yield `[tool result ${message.toolName}] `;
          yield* joined(textBlocks(message, false), "\n");
        })();
        continue;
      }
      // There is no narrative line for messages without visible blocks.
      const visible = [...textBlocks(message, options.thinking ?? false)];
      if (visible.length) yield (function* () {
        yield `[${message.role}]\n`;
        yield* joined(visible, "\n");
      })();
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "toolCall" && options.toolCalls && !executed.has(block.id)) {
            yield (function* () {
              yield `[tool call ${block.name}] `;
              yield* jsonTextChunks(block.arguments);
            })();
          }
        }
      }
    }
  }
  function* text(): Generator<string> {
    let first = true;
    for (const section of sections()) {
      if (!first) yield "\n\n";
      first = false;
      yield* section;
    }
  }
  return { sessionId: turn.sessionId, turnId: turn.id, startedAt: turn.startedAt,
    ...(turn.finishedAt === undefined ? {} : { finishedAt: turn.finishedAt }), status: turn.status,
    pathStatus: classify(turn), text: { [Symbol.iterator]: text }, omitted };
}

function pathTurns(tree: SessionTreeService, id: string, options: ReadOptions): Turn[] {
  const selected = resolveTurn(tree, id);
  if (!selected) return [];
  const saved = tree.livePath(selected.sessionId);
  const path = saved.some((turn) => turn.id === selected.id) ? saved : tree.pathToTurn(selected.id);
  const index = path.findIndex((turn) => turn.id === selected.id);
  const before = Math.max(0, Math.min(10, Math.floor(options.before ?? 0)));
  const after = Math.max(0, Math.min(10, Math.floor(options.after ?? 0)));
  return path.slice(Math.max(0, index - before), index + after + 1);
}

/** Tool read: scan metadata cooperatively before iterating original entries in bounded chunks. */
export async function readPathSegments(tree: SessionTreeService, sessionId: string, id: string,
  options: ReadOptions, signal: AbortSignal): Promise<SessionTurnSegments[]> {
  signal.throwIfAborted();
  const turns = pathTurns(tree, id, options);
  if (turns.length === 0) return [];
  const classify = pathClassifier(tree, sessionId);
  const result: SessionTurnSegments[] = [];
  const maybeYield = cooperativeYield();
  for (const turn of turns) {
    const omitted = new Set<string>();
    const executed = new Set<string>();
    const entries = tree.projection.entriesByTurn.get(turn.id) ?? [];
    const length = entries.length;
    for (let i = 0; i < length; i++) {
      signal.throwIfAborted();
      const entry = entries[i]!;
      if (entry.type === "tool_execution") {
        executed.add(entry.toolCallId);
        if (!options.toolCalls) omitted.add("tool calls");
      } else if (entry.type === "message") {
        const message = entry.message;
        if (message.role === "toolResult") {
          if (!options.toolResults) omitted.add("tool results");
        } else if (message.role === "assistant") {
          for (const block of message.content) {
            if (block.type === "thinking" && !options.thinking) omitted.add("thinking");
            if (block.type === "toolCall" && !options.toolCalls) omitted.add("tool calls");
            await maybeYield(signal);
          }
        }
      }
      await maybeYield(signal);
    }
    result.push(segmentsForTurn(classify, turn, options, entries, length, [...omitted], executed));
    await maybeYield(signal);
  }
  return result;
}
