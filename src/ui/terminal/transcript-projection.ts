import type { SessionEntry, ToolExecutionEntry } from "../../session-tree/model.js";
import type { LiveTurn, TranscriptItem } from "../state.js";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string; thinking?: string } =>
      typeof block === "object" && block !== null && "type" in block
    )
    .map((block) => block.type === "text" ? block.text ?? "" : block.type === "thinking" ? block.thinking ?? "" : "")
    .join("\n")
    .trim();
}

function summarizeArgs(args: Record<string, unknown>): string {
  const rendered = JSON.stringify(args);
  return rendered.length > 160 ? `${rendered.slice(0, 157)}…` : rendered;
}

export function projectLiveUser(turn: Pick<LiveTurn, "id" | "input">): TranscriptItem {
  return { id: `${turn.id}:user`, kind: "user", content: turn.input };
}

export function projectTranscript(entries: readonly SessionEntry[]): TranscriptItem[] {
  const tools = new Map<string, ToolExecutionEntry>();
  for (const entry of entries) if (entry.type === "tool_execution") tools.set(entry.toolCallId, entry);
  const output: TranscriptItem[] = [];
  for (const entry of entries) {
    if (entry.type === "tool_execution") continue;
    if (entry.type === "compaction") {
      output.push({
        id: entry.id,
        kind: "compaction",
        content: `context compacted · ${entry.reason}`,
      });
      continue;
    }
    const message = entry.message;
    if (message.role === "user") {
      output.push({ id: entry.id, kind: "user", content: textContent(message.content) });
      continue;
    }
    if (message.role === "toolResult") {
      const started = tools.get(message.toolCallId);
      output.push({
        id: entry.id,
        kind: "tool",
        content: textContent(message.content),
        name: started?.toolName ?? message.toolName,
        ...(started ? { args: summarizeArgs(started.effectiveArgs) } : {}),
        isError: message.isError,
      });
      continue;
    }
    for (let index = 0; index < message.content.length; index++) {
      const block = message.content[index]!;
      if (block.type === "thinking" && block.thinking.trim()) {
        output.push({ id: `${entry.id}:thinking:${index}`, kind: "thinking", content: block.thinking });
      }
      if (block.type === "text" && block.text.trim()) {
        output.push({ id: `${entry.id}:text:${index}`, kind: "assistant", content: block.text });
      }
    }
  }
  return output;
}
