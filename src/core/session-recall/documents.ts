import { createHash } from "node:crypto";
import type { SessionEntry } from "../session-tree/model.js";
import type { ContentKind, RecallDocument, RecallFragment, TextSpan } from "./types.js";

const RECALL_TOOLS = new Set(["session_search", "session_read"]);
export const CHUNK_VERSION = 1;

export function extractDocuments(entries: readonly SessionEntry[]): RecallDocument[] {
  const executed = new Map<string, Set<string>>();
  const failedAttempts = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type === "tool_execution") {
      const calls = executed.get(entry.assistantEntryId) ?? new Set<string>();
      calls.add(entry.toolCallId);
      executed.set(entry.assistantEntryId, calls);
    } else if (entry.type === "message" && entry.message.role === "assistant") {
      const message = entry.message;
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        failedAttempts.set(entry.id, `[failed assistant attempt ${entry.id} (${message.stopReason})${message.errorMessage ? `: ${message.errorMessage}` : ""}]`);
      }
    }
  }
  const documents: RecallDocument[] = [];
  // Results follow their assistant message; execution facts use their explicit owner.
  let failedAttempt: string | undefined;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role !== "toolResult") {
      failedAttempt = entry.message.role === "assistant" ? failedAttempts.get(entry.id) : undefined;
    }
    const attempt = entry.type === "tool_execution" ? failedAttempts.get(entry.assistantEntryId) : failedAttempt;
    const add = (kind: ContentKind, text: string, index = 0) => {
      if (attempt) text = text ? `${attempt}\n${text}` : attempt;
      if (!text.trim()) return;
      documents.push({
        id: `${entry.id}:${kind}:${index}`, entryId: entry.id, sessionId: entry.sessionId,
        turnId: entry.turnId, kind, text, semantic: kind === "user" || kind === "assistant",
        ...(attempt ? { attemptFailure: attempt } : {}),
      });
    };
    if (entry.type === "compaction" || entry.type === "file_edit") continue;
    if (entry.type === "tool_execution") {
      if (!RECALL_TOOLS.has(entry.toolName)) add("tool-call", `${entry.toolName} ${JSON.stringify(entry.effectiveArgs)}`);
      continue;
    }
    const message = entry.message;
    // System prompt/tool state is request configuration, not project conversation evidence.
    if (message.role === "system") continue;
    if (message.role === "toolResult" && RECALL_TOOLS.has(message.toolName)) continue;
    const kind = message.role === "toolResult" ? "tool-result" : message.role;
    if (typeof message.content === "string") { add(kind, message.content); continue; }
    const start = documents.length;
    for (const [index, block] of message.content.entries()) {
      if (block.type === "text") add(kind, message.role === "toolResult" ? `${message.toolName}\n${block.text}` : block.text, index);
      else if (block.type === "thinking") add("thinking", block.thinking, index);
      else if (block.type === "image") add("image", "[image]", index);
      else if (block.type === "toolCall" && !executed.get(entry.id)?.has(block.id) && !RECALL_TOOLS.has(block.name)) {
        add("tool-call", `${block.name} ${JSON.stringify(block.arguments)}`, index);
      }
    }
    if (message.role === "assistant" && attempt && documents.length === start) {
      add("assistant", "", message.content.length);
    }
  }
  return documents;
}

export function documentsHash(documents: readonly RecallDocument[]): string {
  return createHash("sha256").update(JSON.stringify(documents)).digest("hex");
}

export function fragment(document: RecallDocument, span: TextSpan): RecallFragment {
  const id = createHash("sha256").update(`${document.id}:${span.start}:${span.end}`).digest("hex");
  return { ...document, ...span, id };
}

/** Offsets are UTF-16 positions in the source text block; no reconstructed text. */
export function keywordFragments(document: RecallDocument): RecallFragment[] {
  const spans: TextSpan[] = [];
  let start = 0;
  while (start < document.text.length) {
    let end = Math.min(start + 2_000, document.text.length);
    if (end < document.text.length) {
      const paragraph = document.text.lastIndexOf("\n\n", end - 2);
      if (paragraph > start + 1_000) end = paragraph + 2;
      if (/^[\uDC00-\uDFFF]$/.test(document.text[end]!)) end--;
    }
    spans.push({ start, end, text: document.text.slice(start, end) });
    if (end === document.text.length) break;
    start = end - 200;
    if (/^[\uDC00-\uDFFF]$/.test(document.text[start]!)) start++;
  }
  return spans.map((span) => fragment(document, span));
}
