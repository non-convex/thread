import { Type } from "@earendil-works/pi-ai";
import type { RecallResult, SessionRecallService, TurnDetail } from "../session/recall.js";
import type { AgentTool, ToolResult } from "./types.js";

const STALENESS_NOTICE =
  "Historical session evidence; verify current workspace state when correctness depends on it.";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 30;

function ok(content: string): ToolResult {
  return { content, isError: false };
}

function fail(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true };
}

function formatRecall(result: RecallResult): string {
  const header = [
    STALENESS_NOTICE,
    `Searched ${result.searchedTurns} turns; ${result.totalMatchingTurns} matched.`,
    `Per keyword: ${result.totals.map((total) => `${total.query}=${total.matches}`).join(", ")}`,
    "",
  ];
  if (result.hits.length === 0) {
    return [
      ...header,
      "No turn contained any keyword. Retrieval is literal, so a different wording may match.",
    ].join("\n");
  }
  const body = result.hits.map((hit) =>
    [
      `- ${hit.turnId} [${hit.status}] ${hit.outcome} on ${hit.branchName} at ${
        new Date(hit.startedAt).toISOString()
      }`,
      `  matched: ${hit.matched.join(", ")}`,
      `  ${hit.snippet}`,
    ].join("\n")
  );
  return [...header, ...body, "", "Use session_read with a turn id for that turn's full text."].join("\n");
}

function formatTurn(detail: TurnDetail): string {
  return [
    STALENESS_NOTICE,
    `turn: ${detail.turnId} [${detail.status}] ${detail.outcome} on ${detail.branchName}`,
    `started: ${new Date(detail.startedAt).toISOString()}; finished: ${
      detail.finishedAt ? new Date(detail.finishedAt).toISOString() : "(unfinished)"
    }`,
    ...(detail.omitted.length > 0 ? [`omitted (request only if needed): ${detail.omitted.join(", ")}`] : []),
    "",
    detail.text || "(no narrative text in this turn)",
  ].join("\n");
}

export function createSessionRecallTool(recall: SessionRecallService): AgentTool<{
  queries: string[];
  limit?: number;
}> {
  return {
    name: "session_recall",
    description:
      "Search this project's own conversation history. The Session Tree is the project's memory: it "
      + "holds every earlier turn, including turns compacted out of the live context, turns on branches "
      + "that were rewound, and the reasoning behind past decisions. Use it when the answer is something "
      + "you were told or decided earlier but can no longer see. Matching is literal substring matching, "
      + "so synonyms do not match each other: pass several wordings of the same idea rather than probing "
      + "with one phrase. Per-keyword hit counts distinguish an ineffective keyword from an absent topic.",
    parameters: Type.Object({
      queries: Type.Array(Type.String(), {
        minItems: 1,
        description: "Alternative wordings or related keywords, each matched independently.",
      }),
      limit: Type.Optional(Type.Number({ description: `Maximum turns to return (default ${DEFAULT_LIMIT}).` })),
    }),
    replay: "safe",
    async execute(args, context) {
      try {
        context.signal.throwIfAborted();
        const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(args.limit ?? DEFAULT_LIMIT)));
        return ok(formatRecall(recall.recall(args.queries, limit)));
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
}> {
  return {
    name: "session_read",
    description:
      "Read one turn from this project's conversation history, by the turn id session_recall returned. "
      + "Use it when a snippet is not enough and the exact earlier wording matters. Returns only the "
      + "narrative — what the user and the assistant said — which is where a past decision is almost "
      + "always recorded. Thinking, tool calls and tool output are excluded because they are the bulk of "
      + "a turn's tokens; the response names any section it withheld. Enable one only when the narrative "
      + "does not answer the question, and prefer the narrowest flag.",
    parameters: Type.Object({
      turnId: Type.String(),
      thinking: Type.Optional(Type.Boolean({ description: "Include reasoning blocks. Costly; off by default." })),
      toolCalls: Type.Optional(
        Type.Boolean({ description: "Include tool names and arguments. Costly; off by default." }),
      ),
      toolResults: Type.Optional(
        Type.Boolean({ description: "Include tool output. The most costly section; off by default." }),
      ),
    }),
    replay: "safe",
    async execute(args, context) {
      try {
        context.signal.throwIfAborted();
        const detail = recall.read(args.turnId, args);
        if (!detail) return fail(new Error(`Unknown turn: ${args.turnId}`));
        return ok(formatTurn(detail));
      } catch (error) {
        return fail(error);
      }
    },
  };
}
