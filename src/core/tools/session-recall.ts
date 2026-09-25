import { Type } from "@earendil-works/pi-ai";
import type { SessionRecallService } from "../session-recall/service.js";
import type { RecallSearchResult } from "../session-recall/types.js";
import type { SessionTurnSegments } from "../session-recall/reader.js";
import { cooperativeYield } from "../utils/async.js";
import { singletonResource } from "./execution.js";
import type { AgentTool, ToolResult } from "./types.js";
import { fail } from "./results.js";

const STALENESS_NOTICE = "Historical Session Tree evidence; verify the current workspace when correctness depends on it.";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;
export const SESSION_READ_MAX_BYTES = 64 * 1024;
// Leave room for the range, staleness notice, and continuation instructions.
const SESSION_READ_FOOTER_BYTES = 512;

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

function* formatTurn(detail: SessionTurnSegments): Generator<string> {
  yield [
    STALENESS_NOTICE,
    `session: ${detail.sessionId}; turn: ${detail.turnId} [${detail.pathStatus}] ${detail.status}`,
    `started: ${new Date(detail.startedAt).toISOString()}; finished: ${detail.finishedAt ? new Date(detail.finishedAt).toISOString() : "(unfinished)"}`,
    ...(detail.omitted.length ? [`omitted: ${detail.omitted.join(", ")}`] : []),
    "",
  ].join("\n") + "\n";
  const narrative = detail.text[Symbol.iterator]();
  const first = narrative.next();
  if (first.done) yield "(no narrative text in this turn)";
  else {
    yield first.value;
    for (let next = narrative.next(); !next.done; next = narrative.next()) yield next.value;
  }
}

function* formatPath(details: SessionTurnSegments[]): Generator<string> {
  for (let index = 0; index < details.length; index++) {
    if (index) yield "\n\n";
    yield `[path turn ${index + 1}/${details.length}]\n`;
    yield* formatTurn(details[index]!);
  }
}

/** Keep surrogate pairs intact across both chunk boundaries and adjacent narrative parts. */
function* utf8Chunks(parts: Iterable<string>): Generator<string> {
  const chunkSize = 8 * 1024;
  const high = (code: number) => code >= 0xd800 && code <= 0xdbff;
  const low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
  let pendingHigh = "";
  for (const part of parts) {
    let start = 0;
    if (pendingHigh && part.length) {
      if (low(part.charCodeAt(0))) { yield pendingHigh + part.slice(0, 1); start = 1; }
      else yield pendingHigh;
      pendingHigh = "";
    }
    while (start < part.length) {
      let end = Math.min(part.length, start + chunkSize);
      if (end < part.length && high(part.charCodeAt(end - 1)) && low(part.charCodeAt(end))) end--;
      if (end === part.length && high(part.charCodeAt(end - 1))) {
        if (end - 1 > start) yield part.slice(start, end - 1);
        pendingHigh = part.slice(end - 1);
        break;
      }
      yield part.slice(start, end);
      start = end;
    }
  }
  if (pendingHigh) yield pendingHigh;
}

async function presentReadPage(details: SessionTurnSegments[], offset: number, signal: AbortSignal): Promise<ToolResult> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative safe integer");
  const maybeYield = cooperativeYield();
  let totalBytes = 0;
  for (const chunk of utf8Chunks(formatPath(details))) {
    signal.throwIfAborted();
    totalBytes += Buffer.byteLength(chunk, "utf8");
    await maybeYield(signal);
  }
  if (offset >= totalBytes) throw new Error(`Offset ${offset} is beyond end of history (${totalBytes} bytes total)`);
  const paginated = offset > 0 || totalBytes > SESSION_READ_MAX_BYTES;
  let end = Math.min(totalBytes, offset + SESSION_READ_MAX_BYTES - (paginated ? SESSION_READ_FOOTER_BYTES : 0));
  const pieces: Buffer[] = [];
  let at = 0;
  for (const chunk of utf8Chunks(formatPath(details))) {
    signal.throwIfAborted();
    const next = at + Buffer.byteLength(chunk, "utf8");
    if (next <= offset) { at = next; await maybeYield(signal); continue; }
    if (at >= end) break;
    const bytes = Buffer.from(chunk, "utf8");
    if (offset >= at && (bytes[offset - at]! & 0xc0) === 0x80) {
      throw new Error("offset is inside a UTF-8 character; use the continuation offset from the previous result");
    }
    if (end < next && end < totalBytes) {
      let localEnd = end - at;
      // Each chunk begins on a code-point boundary, so the character head is in this chunk.
      while ((bytes[localEnd]! & 0xc0) === 0x80) localEnd--;
      end = at + localEnd;
    }
    pieces.push(bytes.subarray(Math.max(0, offset - at), end < next ? end - at : bytes.length));
    if (next >= end) break;
    at = next;
    await maybeYield(signal);
  }
  const page = Buffer.concat(pieces);
  const more = end < totalBytes;
  const footer = paginated
    ? `\n\n[${STALENESS_NOTICE}\nShowing UTF-8 bytes ${offset}–${end - 1} of ${totalBytes}. ${
        more ? `Continue with offset=${end} and the same turnId, thinking, toolCalls, toolResults, before, and after options.` : "End of history."
      }]`
    : "";
  return {
    content: page.toString("utf8") + footer,
    isError: false,
    details: { offset, shownBytes: end - offset, totalBytes, ...(more ? { nextOffset: end } : {}) },
  };
}

export function createSessionSearchTool(recall: SessionRecallService): AgentTool<{ queries: string[]; limit?: number }> {
  return {
    name: "session_search",
    description:
      "Search the entire project Session Tree, including compacted-away turns, other root Sessions, and paths retained after rewind. " +
      "Use this only when the user's current request depends on project history and the needed information or original evidence is missing from the current context. " +
      "Search combines Chinese-aware keywords and local semantic recall. Use descriptions of earlier decisions or attempts, or exact identifiers. " +
      "Only ended turns are searched; indexing coverage is reported with results.",
    parameters: Type.Object({
      queries: Type.Array(Type.String(), { minItems: 1, description: "Descriptions, keywords, or alternative phrasings of the same information need." }),
      limit: Type.Optional(Type.Number({ description: `Maximum turns to return (default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}).` })),
    }),
    execution: {
      effect: "read",
      mode: "parallel",
      resources: () => singletonResource("session-tree", "*", "read", "subtree"),
    },
    async execute(args, context) {
      try {
        context.signal.throwIfAborted();
        const sessionId = context.invocation.sessionId;
        if (!sessionId) throw new Error("Session recall requires an invoking session");
        const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)));
        const result = await recall.search(sessionId, args.queries, limit, context.signal);
        return { content: formatSearch(result), isError: false,
          details: { hits: result.hits.length, coverage: result.coverage, semantic: result.semantic, diagnostics: result.diagnostics } };
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
      "Read a relevant historical turn found by session_search or whose id is already known, in pages of at most 64KB. " +
      "Use this only when the user's current request depends on project history and the needed information or original evidence is missing from the current context. " +
      "Narrative is returned by default; thinking, tool calls, and tool results are opt-in because they can be large. " +
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
    execution: {
      effect: "read",
      mode: "parallel",
      resources: (args) => singletonResource("session-tree", args.turnId, "read"),
    },
    async execute(args, context) {
      try {
        context.signal.throwIfAborted();
        const sessionId = context.invocation.sessionId;
        if (!sessionId) throw new Error("Session recall requires an invoking session");
        const details = await recall.readPathSegments(sessionId, args.turnId, args, context.signal);
        return details.length ? await presentReadPage(details, args.offset ?? 0, context.signal) : fail(new Error(`Unknown turn: ${args.turnId}`));
      } catch (error) {
        return fail(error);
      }
    },
  };
}
