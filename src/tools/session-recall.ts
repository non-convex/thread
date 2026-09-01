import { Type } from "@earendil-works/pi-ai";
import type { SessionSearchResult, SessionSearchService, SessionTurnDetail } from "../session-tree/search.js";
import type { AgentTool, ToolResult } from "./types.js";

const STALENESS_NOTICE = "Historical Session Tree evidence; verify the current workspace when correctness depends on it.";
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 30;

function ok(content: string): ToolResult {
  return { content, isError: false };
}

function fail(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true };
}

function formatSearch(result: SessionSearchResult): string {
  const header = [
    STALENESS_NOTICE,
    `Searched ${result.searchedTurns} turns; ${result.totalMatchingTurns} matched.`,
    `Per keyword: ${result.totals.map((total) => `${total.query}=${total.matches}`).join(", ")}`,
    "",
  ];
  if (result.hits.length === 0) {
    return [...header, "No turn contained any keyword. Search is literal, so try related wording."].join("\n");
  }
  const body = result.hits.map((hit) => [
    `- session=${hit.sessionId} turn=${hit.turnId} [${hit.pathStatus}] ${hit.status} ${new Date(hit.startedAt).toISOString()}`,
    `  matched: ${hit.matched.join(", ")}`,
    `  ${hit.snippet}`,
  ].join("\n"));
  return [...header, ...body, "", "Use session_read with a turn id for complete turn text."].join("\n");
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

export function createSessionSearchTool(search: SessionSearchService): AgentTool<{ queries: string[]; limit?: number }> {
  return {
    name: "session_search",
    description:
      "Search the entire project Session Tree, including other root Sessions and paths retained after rewind. " +
      "Use several literal alternative wordings when recalling an earlier decision or attempt.",
    parameters: Type.Object({
      queries: Type.Array(Type.String(), { minItems: 1, description: "Literal keywords or alternative phrasings." }),
      limit: Type.Optional(Type.Number({ description: `Maximum turns to return (default ${DEFAULT_LIMIT}).` })),
    }),
    replay: "safe",
    async execute(args, context) {
      try {
        context.signal.throwIfAborted();
        const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)));
        return ok(formatSearch(search.search(args.queries, limit)));
      } catch (error) {
        return fail(error);
      }
    },
  };
}

export function createSessionReadTool(search: SessionSearchService): AgentTool<{
  turnId: string;
  thinking?: boolean;
  toolCalls?: boolean;
  toolResults?: boolean;
  before?: number;
  after?: number;
}> {
  return {
    name: "session_read",
    description:
      "Read one complete historical turn returned by session_search. Narrative is returned by default; " +
      "thinking, tool calls, and tool results are opt-in because they can be large.",
    parameters: Type.Object({
      turnId: Type.String(),
      thinking: Type.Optional(Type.Boolean()),
      toolCalls: Type.Optional(Type.Boolean()),
      toolResults: Type.Optional(Type.Boolean()),
      before: Type.Optional(Type.Number({ description: "Include up to 10 ancestor turns before the selected turn." })),
      after: Type.Optional(Type.Number({ description: "Include up to 10 later turns when the selected turn is on its Session's saved live path." })),
    }),
    replay: "safe",
    async execute(args, context) {
      try {
        context.signal.throwIfAborted();
        const details = search.readPath(args.turnId, args);
        return details.length ? ok(formatPath(details)) : fail(new Error(`Unknown turn: ${args.turnId}`));
      } catch (error) {
        return fail(error);
      }
    },
  };
}
