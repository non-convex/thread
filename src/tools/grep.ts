import { lstat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Type } from "@earendil-works/pi-ai";
import { ProcessError, runProcess } from "../utils/process.js";
import { workspacePathClaim } from "./execution.js";
import { resolveWorkspacePath } from "./path-safety.js";
import type { AgentTool, ToolResult } from "./types.js";
import {
  assertCursorCompatible, clampInt, decodeGrepCursor, presentContentPage, presentFilesPage,
  renderMatchWithContext, searchFromArgs, GREP_DEFAULT_LIMIT, GREP_MAX_CONTEXT, GREP_MAX_LIMIT,
  GREP_SCAN_BYTES, GREP_SCAN_CAP, type GrepArgs, type GrepDetails, type GrepMatch,
} from "./grep-results.js";

const MODEL_OUTPUT_LIMIT = 64 * 1024;

function ok(content: string, details?: GrepDetails): ToolResult {
  return { content, isError: false, ...(details === undefined ? {} : { details }) };
}

function fail(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true };
}

function limited(value: string, max = MODEL_OUTPUT_LIMIT): string {
  if (Buffer.byteLength(value, "utf8") <= max) return value;
  return `${Buffer.from(value, "utf8").subarray(0, max).toString("utf8")}\n[output truncated at ${max} bytes]`;
}

export function grepFilePath(root: string, absolute: string): string {
  const resolved = path.resolve(absolute);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return resolved;
  return relative.split(path.sep).join("/");
}

function parseGitStatus(porcelain: string): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const raw of porcelain.split(/\r?\n/)) {
    if (raw.length < 4) continue;
    const xy = raw.slice(0, 2);
    if (xy === "!!") continue;
    let rest = raw.slice(3);
    const arrow = rest.indexOf(" -> ");
    if (arrow >= 0) rest = rest.slice(arrow + 4);
    const file = rest.replaceAll("\\", "/").replace(/^"(.*)"$/, "$1");
    if (!file) continue;
    const boost = xy === "??" ? 1 : 2;
    ranks.set(file, Math.max(ranks.get(file) ?? 0, boost));
  }
  return ranks;
}

function orderMatches(
  matches: GrepMatch[],
  gitBoost: Map<string, number>,
  mtimes: Map<string, number>,
): GrepMatch[] {
  const files = [...new Set(matches.map((match) => match.file))];
  files.sort((left, right) => {
    const git = (gitBoost.get(right) ?? 0) - (gitBoost.get(left) ?? 0);
    if (git !== 0) return git;
    const time = (mtimes.get(right) ?? 0) - (mtimes.get(left) ?? 0);
    if (time !== 0) return time;
    return left.localeCompare(right);
  });
  const grouped = new Map<string, GrepMatch[]>();
  for (const match of matches) {
    const list = grouped.get(match.file) ?? [];
    list.push(match);
    grouped.set(match.file, list);
  }
  const ordered: GrepMatch[] = [];
  for (const file of files) {
    const list = grouped.get(file);
    if (!list) continue;
    list.sort((left, right) => left.line - right.line);
    ordered.push(...list);
  }
  return ordered;
}

interface RgMatchEvent {
  type: "match";
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

function appendRgMatch(line: string, root: string, matches: GrepMatch[]): boolean {
  if (!line) return false;
  let event: RgMatchEvent;
  try {
    event = JSON.parse(line) as RgMatchEvent;
  } catch {
    return false;
  }
  if (event.type !== "match") return false;
  const absolute = event.data?.path?.text;
  const lineNumber = event.data?.line_number;
  if (!absolute || typeof lineNumber !== "number") return false;
  const file = grepFilePath(root, absolute);
  matches.push({ file, line: lineNumber, text: event.data?.lines?.text ?? "" });
  return matches.length >= GREP_SCAN_CAP;
}

async function scanRgMatches(
  args: readonly string[],
  root: string,
  signal: AbortSignal,
): Promise<{ matches: GrepMatch[]; scanCapped: boolean }> {
  const matches: GrepMatch[] = [];
  const stop = new AbortController();
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let bytes = 0;
  let scanCapped = false;
  const cap = () => {
    scanCapped = true;
    pending = "";
    stop.abort();
  };
  const result = await runProcess("rg", args, {
    cwd: root,
    signal: AbortSignal.any([signal, stop.signal]),
    allowExitCodes: "any",
    maxOutputBytes: GREP_SCAN_BYTES,
    onStdout(chunk) {
      if (scanCapped || signal.aborted) return;
      const accepted = chunk.subarray(0, GREP_SCAN_BYTES - bytes);
      bytes += accepted.length;
      pending += decoder.write(accepted);
      let start = 0;
      for (let end = pending.indexOf("\n", start); end >= 0; end = pending.indexOf("\n", start)) {
        if (appendRgMatch(pending.slice(start, end), root, matches)) {
          cap();
          return;
        }
        start = end + 1;
      }
      pending = pending.slice(start);
      if (bytes >= GREP_SCAN_BYTES) cap();
    },
  });
  // Reaching our scan cap is successful partial output; user cancellation and rg errors are not.
  signal.throwIfAborted();
  if (!scanCapped) {
    if (![0, 1].includes(result.code)) throw new ProcessError(result);
    scanCapped = appendRgMatch(pending + decoder.end(), root, matches);
  }
  return { matches, scanCapped };
}

async function gitBoostFor(root: string, signal: AbortSignal): Promise<Map<string, number>> {
  try {
    const result = await runProcess("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: root,
      signal,
      allowExitCodes: [0],
      maxOutputBytes: 1024 * 1024,
    });
    return parseGitStatus(result.stdout.toString("utf8"));
  } catch {
    return new Map();
  }
}

async function mtimesFor(root: string, files: Iterable<string>): Promise<Map<string, number>> {
  const mtimes = new Map<string, number>();
  await Promise.all(
    [...files].map(async (file) => {
      try {
        const stat = await lstat(path.join(root, file));
        mtimes.set(file, stat.mtimeMs);
      } catch {
        mtimes.set(file, 0);
      }
    }),
  );
  return mtimes;
}

export const grepTool: AgentTool<GrepArgs> = {
  name: "grep",
  description:
    "Search text with ripgrep. Defaults to the workspace root; absolute paths and paths outside the project are allowed. Matches are grouped by file and ranked so git-changed and recently modified files come first, then paginated (default 20 matches, max 100). Use glob to narrow, outputMode=files for ranked paths only, and pass cursor unchanged to continue the same search. Hidden files are not searched; .gitignore is respected. Requires rg on PATH.",
  parameters: Type.Object({
    pattern: Type.String({ description: "Search pattern (regex, or a literal string when literal is true)." }),
    path: Type.Optional(
      Type.String({ description: "Directory or file to search; defaults to the workspace root." }),
    ),
    glob: Type.Optional(Type.String({ description: "Limit files, e.g. '*.ts' or 'src/**/*.ts'." })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search; default false." })),
    literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string; default false." })),
    context: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: GREP_MAX_CONTEXT,
        description: "Lines before and after each match on the current page; default 0.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: GREP_MAX_LIMIT,
        description: `Matches (or files in files mode) per page; default ${GREP_DEFAULT_LIMIT}.`,
      }),
    ),
    outputMode: Type.Optional(
      Type.Union([Type.Literal("content"), Type.Literal("files")], {
        description: "content (default) returns grouped lines; files returns ranked paths with counts.",
      }),
    ),
    cursor: Type.Optional(
      Type.String({
        description: "Pagination cursor from a previous grep result. Pass it unchanged to fetch the next page.",
      }),
    ),
  }),
  replay: "safe",
  execution: {
    effect: "read",
    mode: "parallel",
    resources: async (args, context) => [
      await workspacePathClaim(context.rootPath, args.path?.trim() || ".", "read", {
        allowOutside: true,
        scope: "subtree",
      }),
    ],
  },
  async execute(args, context) {
    try {
      context.signal.throwIfAborted();
      const pattern = args.pattern.trim();
      if (!pattern) throw new Error("pattern cannot be empty");
      const cursor = args.cursor ? decodeGrepCursor(args.cursor) : undefined;
      if (cursor) assertCursorCompatible({ ...args, pattern }, cursor.search);
      const search = cursor?.search ?? searchFromArgs({ ...args, pattern });
      const offset = cursor?.offset ?? 0;
      const limit = clampInt(args.limit, 1, GREP_MAX_LIMIT, GREP_DEFAULT_LIMIT);
      const target = await resolveWorkspacePath(context.rootPath, search.path, { allowOutside: true });
      const rgArgs = ["--json", "--line-number", "--color", "never"];
      if (search.ignoreCase) rgArgs.push("--ignore-case");
      if (search.literal) rgArgs.push("--fixed-strings");
      if (search.glob) rgArgs.push("--glob", search.glob);
      rgArgs.push("--", search.pattern, target);
      let parsed: { matches: GrepMatch[]; scanCapped: boolean };
      try {
        parsed = await scanRgMatches(rgArgs, context.rootPath, context.signal);
      } catch (error) {
        if (error instanceof ProcessError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("ripgrep (rg) was not found on PATH");
        throw error;
      }
      const gitBoost = await gitBoostFor(context.rootPath, context.signal);
      const mtimes = await mtimesFor(context.rootPath, new Set(parsed.matches.map((match) => match.file)));
      const ordered = orderMatches(parsed.matches, gitBoost, mtimes);
      if (search.outputMode === "files") {
        const presented = presentFilesPage({ ordered, offset, limit, search, scanCapped: parsed.scanCapped });
        return ok(limited(presented.content), presented.details);
      }
      const page = ordered.slice(offset, offset + limit);
      const renderLine = await renderMatchWithContext(context.rootPath, page, search.context);
      const presented = presentContentPage({
        ordered,
        offset,
        limit,
        search,
        scanCapped: parsed.scanCapped,
        renderLine,
      });
      return ok(limited(presented.content), presented.details);
    } catch (error) {
      return fail(error);
    }
  },
};
