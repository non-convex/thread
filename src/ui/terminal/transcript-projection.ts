import type { SessionEntry, ToolStartedRecord } from "../../domain.js";
import type { TranscriptItem } from "../state.js";

export const TRANSCRIPT_REPLAY_USER_MESSAGES = 8;

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const value = block as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") return value.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function thinkingText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const value = block as Record<string, unknown>;
      if (value.type === "thinking" && typeof value.thinking === "string") return value.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function argSummary(args: Record<string, unknown>): string {
  for (const key of ["path", "command", "pattern", "query"]) {
    const value = args[key];
    if (typeof value === "string") return value.replace(/\s+/g, " ").slice(0, 120);
  }
  const encoded = JSON.stringify(args);
  return encoded === "{}" ? "" : encoded.slice(0, 120);
}

function toolResultSummary(name: string, args: Record<string, unknown>, content: string): string {
  const target = argSummary(args);
  if (name === "read" && target) return target;
  const first = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first.slice(0, 180) || target || "completed";
}

function messageTranscriptItems(
  entryId: string,
  message: Extract<SessionEntry, { type: "message" }>["message"],
  toolRecords: ReadonlyMap<string, ToolStartedRecord>,
): TranscriptItem[] {
  if (message.role === "user") return [{ id: entryId, kind: "user", content: contentText(message.content) }];
  if (message.role === "assistant") {
    const items: TranscriptItem[] = [];
    const thinking = thinkingText(message.content);
    if (thinking) items.push({ id: `${entryId}:thinking`, kind: "thinking", content: thinking });
    const text = contentText(message.content);
    if (text) items.push({ id: entryId, kind: "assistant", content: text });
    return items;
  }
  if (message.role === "toolResult") {
    const record = toolRecords.get(entryId);
    const args = record?.effectiveArgs ?? {};
    const name = message.toolName || record?.toolName || "tool";
    const text = contentText(message.content);
    const target = argSummary(args);
    return [{
      id: entryId,
      kind: "tool",
      label: target ? `${name}  ${target}` : name,
      name,
      args: target,
      content: toolResultSummary(name, args, text),
      isError: message.isError,
    }];
  }
  return [];
}

function transcriptItems(entry: SessionEntry, toolRecords: ReadonlyMap<string, ToolStartedRecord>): TranscriptItem[] {
  if (entry.type === "squash") {
    const squash: TranscriptItem = {
      id: entry.id,
      kind: "squash",
      label: entry.summaryKind === "project_state" ? "project state" : "selected turn",
      content: `[Checkpointed workspace changes]\n${entry.workspaceDiffStat}\n\n[Narrative]\n${entry.summary}`,
    };
    return [
      squash,
      ...entry.retainedTail.flatMap((retained) =>
        messageTranscriptItems(retained.sourceEntryId, retained.message, toolRecords)
      ),
    ];
  }
  if (entry.type === "context_merge") {
    return [{ id: entry.id, kind: "context_merge", label: entry.sourceRef, content: entry.content }];
  }
  if (entry.type !== "message") return [];
  return messageTranscriptItems(entry.id, entry.message, toolRecords);
}

export function projectTranscript(
  sourcePath: readonly SessionEntry[],
  records: readonly ToolStartedRecord[],
  hiddenThroughEntryId?: string,
): TranscriptItem[] {
  let path = sourcePath;
  if (hiddenThroughEntryId) {
    const hiddenIndex = path.findIndex((entry) => entry.id === hiddenThroughEntryId);
    if (hiddenIndex >= 0) path = path.slice(hiddenIndex + 1);
  }
  const toolRecords = new Map(records.map((record) => [record.resultEntryId, record] as const));
  const items = path.flatMap((entry) => transcriptItems(entry, toolRecords));
  let start = items.length;
  let userBoundaries = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === "user" || (item.kind === "squash" && item.label === "selected turn")) userBoundaries++;
    start = index;
    if (userBoundaries >= TRANSCRIPT_REPLAY_USER_MESSAGES) break;
  }
  return items.slice(start);
}
