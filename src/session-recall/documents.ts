import { createHash } from "node:crypto";
import type { SessionEntry } from "../session-tree/model.js";
import type { ContentKind, RecallDocument, RecallFragment, TextSpan } from "./types.js";

const RECALL_TOOLS = new Set(["session_search", "session_read"]);
export const CHUNK_VERSION = 1;

export function extractDocuments(entries: readonly SessionEntry[]): RecallDocument[] {
  const executed = new Set(entries.filter((entry) => entry.type === "tool_execution").map((entry) => entry.toolCallId));
  const documents: RecallDocument[] = [];
  for (const entry of entries) {
    const add = (kind: ContentKind, text: string, index = 0) => {
      if (!text.trim()) return;
      documents.push({
        id: `${entry.id}:${kind}:${index}`, entryId: entry.id, sessionId: entry.sessionId,
        turnId: entry.turnId, kind, text, semantic: kind === "user" || kind === "assistant",
      });
    };
    if (entry.type === "compaction") continue;
    if (entry.type === "tool_execution") {
      if (!RECALL_TOOLS.has(entry.toolName)) add("tool-call", `${entry.toolName} ${JSON.stringify(entry.effectiveArgs)}`);
      continue;
    }
    const message = entry.message;
    if (message.role === "toolResult" && RECALL_TOOLS.has(message.toolName)) continue;
    const kind = message.role === "toolResult" ? "tool-result" : message.role;
    if (typeof message.content === "string") { add(kind, message.content); continue; }
    for (const [index, block] of message.content.entries()) {
      if (block.type === "text") add(kind, message.role === "toolResult" ? `${message.toolName}\n${block.text}` : block.text, index);
      else if (block.type === "thinking") add("thinking", block.thinking, index);
      else if (block.type === "image") add("image", "[image]", index);
      else if (block.type === "toolCall" && !executed.has(block.id) && !RECALL_TOOLS.has(block.name)) {
        add("tool-call", `${block.name} ${JSON.stringify(block.arguments)}`, index);
      }
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
