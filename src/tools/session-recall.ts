import { Type } from "@earendil-works/pi-ai";
import type { SessionRecallService } from "../session-recall/service.js";
import type { RecallSearchResult, SessionTurnDetail } from "../session-recall/types.js";
import { singletonResource } from "./execution.js";
import type { AgentTool, ToolResult } from "./types.js";

const STALENESS_NOTICE = "Historical Session Tree evidence; verify the current workspace when correctness depends on it.";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;
export const SESSION_READ_MAX_BYTES = 64 * 1024;
// Leave room for the range, staleness notice, and continuation instructions.
const SESSION_READ_FOOTER_BYTES = 512;

function ok(content: string): ToolResult {
  return { content, isError: false };
}

function fail(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true };
}

function formatSearch(result: RecallSearchResult): string {
  const header = [
    STALENESS_NOTICE,
    `Keyword coverage: ${result.coverage.keywordTurns}/${result.coverage.totalTurns} ended turns.`,
    `Semantic recall: ${result.semantic}; coverage ${result.coverage.semanticTurns}/${result.coverage.totalTurns}.`,
    ...result.diagnostics,
    "",
  ];
  if (result.hits.length === 0) {
    return [...header, "No related turns found. Try another description or a specific identifier."].join("\n");
  }
  const body = result.hits.map((hit) => [
    `- session=${hit.sessionId} turn=${hit.turnId} [${hit.pathStatus}] ${hit.status} ${new Date(hit.startedAt).toISOString()}`,
    `  entry=${hit.entryId}; kind=${hit.kind}; sources: ${hit.sources.join(", ")}; queries: ${hit.queries.join(", ")}`,
    `  ${hit.snippet}`,
  ].join("\n"));
  return [...header, ...body, "", "Semantic hits are related candidates and may not contain the query words. Use session_read with a turn id for original evidence."].join("\n");
}

function formatTurn(detail: SessionTurnDetail): string {
  return [
    STALENESS_NOTICE,
    `session: ${detail.sessionId}; turn: ${detail.turnId} [${detail.pathStatus}] ${detail.status}`,
    `started: ${new Date(detail.startedAt).toISOString()}; finished: ${detail.finishedAt ? new Date(detail.finishedAt).toISOString() : "(unfinished)"}`,
    ...(detail.omitted.length ? [`omitted: ${detail.omitted.join(", ")}`] : []),
    "",
    detail.text || "(no narrative text in this turn)",
  ].join("\n");
}

function formatPath(details: SessionTurnDetail[]): string {
  return details.map((detail, index) =>
    `[path turn ${index + 1}/${details.length}]\n${formatTurn(detail)}`
  ).join("\n\n");
}

function presentReadPage(text: string, offset: number): ToolResult {
  const buffer = Buffer.from(text, "utf8");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer");
  if (offset >= buffer.length) throw new Error(`Offset ${offset} is beyond end of history (${buffer.length} bytes total)`);
  if ((buffer[offset]! & 0xc0) === 0x80) throw new Error("offset is inside a UTF-8 character; use the continuation offset from the previous result");
  const paginated = offset > 0 || buffer.length > SESSION_READ_MAX_BYTES;
  let end = Math.min(buffer.length, offset + SESSION_READ_MAX_BYTES - (paginated ? SESSION_READ_FOOTER_BYTES : 0));
  // Do not split a Chinese character or emoji between pages.
  while (end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end--;
  const more = end < buffer.length;
  const footer = paginated
    ? `\n\n[${STALENESS_NOTICE}\nShowing UTF-8 bytes ${offset}–${end - 1} of ${buffer.length}. ${
        more ? `Continue with offset=${end} and the same turnId, thinking, toolCalls, toolResults, before, and after options.` : "End of history."
      }]`
    : "";
  return {
    content: buffer.subarray(offset, end).toString("utf8") + footer,
    isError: false,
    details: { offset, shownBytes: end - offset, totalBytes: buffer.length, ...(more ? { nextOffset: end } : {}) },
  };
}

export function createSessionSearchTool(recall: SessionRecallService): AgentTool<{ queries: string[]; limit?: number }> {
  return {
    name: "session_search",
    description:
      "Search the entire project Session Tree, including compacted-away turns, other root Sessions, and paths retained after rewind. " +
      "Use this instead of guessing when a question depends on earlier project decisions that are not in the current context. " +
      "Search combines Chinese-aware keywords and local semantic recall. Use descriptions of earlier decisions or attempts, or exact identifiers. " +
      "Only ended turns are searched; indexing coverage is reported with results.",
    parameters: Type.Object({
      queries: Type.Array(Type.String(), { minItems: 1, description: "Descriptions, keywords, or alternative phrasings of the same information need." }),
      limit: Type.Optional(Type.Number({ description: `Maximum turns to return (default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}).` })),
    }),
    replay: "safe",
    execution: {
      effect: "read",
      mode: "parallel",
      resources: () => singletonResource("session-tree", "*", "read", "subtree"),
    },
    async execute(args, context) {
      try {
        context.signal.throwIfAborted();
        const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)));
        return ok(formatSearch(await recall.search(args.queries, limit, context.signal)));
      } catch (error) {
        return fail(error);
      }
    },
  };
}

export function createSessionReadTool(recall: SessionRecallService): AgentTool<{
  turnId: string;
  thinking?: boolean;
  toolCalls?: boolean;
  toolResults?: boolean;
  before?: number;
  after?: number;
  offset?: number;
}> {
  return {
    name: "session_read",
    description:
      "Read a historical turn returned by session_search, in pages of at most 64KB. Narrative is returned by default; " +
      "thinking, tool calls, and tool results are opt-in because they can be large. " +
      "Use the continuation offset with the same turnId and read options to read the next page.",
    parameters: Type.Object({
      turnId: Type.String(),
      thinking: Type.Optional(Type.Boolean()),
      toolCalls: Type.Optional(Type.Boolean()),
      toolResults: Type.Optional(Type.Boolean()),
      before: Type.Optional(Type.Number({ description: "Include up to 10 ancestor turns before the selected turn." })),
      after: Type.Optional(Type.Number({ description: "Include up to 10 later turns when the selected turn is on its Session's saved live path." })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "UTF-8 byte offset from the previous page; default 0. Keep all other read options unchanged." })),
    }),
    replay: "safe",
    execution: {
      effect: "read",
      mode: "parallel",
      resources: (args) => singletonResource("session-tree", args.turnId, "read"),
    },
    async execute(args, context) {
      try {
        context.signal.throwIfAborted();
        const details = recall.readPath(args.turnId, args);
        return details.length ? presentReadPage(formatPath(details), args.offset ?? 0) : fail(new Error(`Unknown turn: ${args.turnId}`));
      } catch (error) {
        return fail(error);
      }
    },
  };
}
