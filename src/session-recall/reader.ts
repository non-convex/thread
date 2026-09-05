import type { Message } from "@earendil-works/pi-ai";
import type { SessionTreeService } from "../session-tree/service.js";
import type { Turn } from "../session-tree/model.js";
import type { HistoryPathStatus, ReadOptions, SessionTurnDetail } from "./types.js";

export function pathClassifier(tree: SessionTreeService): (turn: Turn) => HistoryPathStatus {
  const sessionId = tree.activeSession.id;
  const current = new Set(tree.livePath().map((turn) => turn.id));
  return (turn) => turn.sessionId !== sessionId ? "other-session"
    : current.has(turn.id) ? "current-path" : "current-session-off-path";
}

function textBlocks(message: Message, thinking: boolean): string[] {
  if (typeof message.content === "string") return [message.content];
  return message.content.flatMap((block) => block.type === "text" ? [block.text]
    : block.type === "image" ? ["[image]"]
    : block.type === "thinking" && thinking ? [block.thinking] : []);
}

export function readTurn(tree: SessionTreeService, id: string, options: ReadOptions = {}): SessionTurnDetail | undefined {
  const matches = [...tree.projection.turns.values()].filter((turn) => turn.id === id || turn.id.startsWith(id));
  if (matches.length === 0) return undefined;
  if (matches.length > 1) throw new Error(`Turn prefix is ambiguous: ${id}`);
  const turn = matches[0]!;
  const entries = tree.entriesForTurn(turn.id);
  const executed = new Set(entries.filter((entry) => entry.type === "tool_execution").map((entry) => entry.toolCallId));
  const lines: string[] = [];
  const omitted = new Set<string>();
  for (const entry of entries) {
    if (entry.type === "compaction") continue;
    if (entry.type === "tool_execution") {
      if (options.toolCalls) lines.push(`[tool call ${entry.toolName}] ${JSON.stringify(entry.effectiveArgs)}`);
      else omitted.add("tool calls");
      continue;
    }
    const message = entry.message;
    if (message.role === "toolResult") {
      if (options.toolResults) lines.push(`[tool result ${message.toolName}] ${textBlocks(message, false).join("\n")}`);
      else omitted.add("tool results");
      continue;
    }
    const text = textBlocks(message, options.thinking ?? false);
    if (text.length) lines.push(`[${message.role}]\n${text.join("\n")}`);
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "thinking" && !options.thinking) omitted.add("thinking");
        if (block.type !== "toolCall") continue;
        if (!options.toolCalls) omitted.add("tool calls");
        else if (!executed.has(block.id)) lines.push(`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`);
      }
    }
  }
  return { sessionId: turn.sessionId, turnId: turn.id, startedAt: turn.startedAt,
    ...(turn.finishedAt === undefined ? {} : { finishedAt: turn.finishedAt }), status: turn.status,
    pathStatus: pathClassifier(tree)(turn), text: lines.join("\n\n"), omitted: [...omitted] };
}

export function readPath(tree: SessionTreeService, id: string, options: ReadOptions = {}): SessionTurnDetail[] {
  const selected = readTurn(tree, id, options);
  if (!selected) return [];
  const saved = tree.livePath(selected.sessionId);
  const path = saved.some((turn) => turn.id === selected.turnId) ? saved : tree.pathToTurn(selected.turnId);
  const index = path.findIndex((turn) => turn.id === selected.turnId);
  const before = Math.max(0, Math.min(10, Math.floor(options.before ?? 0)));
  const after = Math.max(0, Math.min(10, Math.floor(options.after ?? 0)));
  return path.slice(Math.max(0, index - before), index + after + 1).map((turn) => readTurn(tree, turn.id, options)!);
}
