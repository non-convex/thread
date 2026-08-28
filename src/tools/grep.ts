import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { ProcessError, runProcess } from "../utils/process.js";
import { resolveWorkspacePath } from "./path-safety.js";
import type { AgentTool, ToolResult } from "./types.js";

export const GREP_DEFAULT_LIMIT = 20;
export const GREP_MAX_LIMIT = 100;
export const GREP_SCAN_CAP = 2_000;
export const GREP_MAX_LINE_CHARS = 200;
export const GREP_MAX_CONTEXT = 5;
export const GREP_SCAN_BYTES = 8 * 1024 * 1024;
const MODEL_OUTPUT_LIMIT = 64 * 1024;
const CURSOR_PREFIX = "g1.";

export type GrepOutputMode = "content" | "files";

export type GrepArgs = {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
  outputMode?: GrepOutputMode;
  cursor?: string;
};

export interface GrepSearch {
  pattern: string;
  path: string;
  glob?: string;
  ignoreCase: boolean;
  literal: boolean;
  context: number;
  outputMode: GrepOutputMode;
}

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface GrepDetails {
  totalMatches: number;
  totalFiles: number;
  offset: number;
  shown: number;
  scanCapped: boolean;
  nextCursor?: string;
}

export interface GrepCursor {
  v: 1;
  search: GrepSearch;
  offset: number;
}

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

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function posixRel(root: string, absolute: string): string | undefined {
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

export function clipLine(text: string): string {
  const cleaned = text.replace(/\r/g, "").replace(/\n$/, "");
  if (cleaned.length <= GREP_MAX_LINE_CHARS) return cleaned;
  return `${cleaned.slice(0, GREP_MAX_LINE_CHARS)}…`;
}

export function searchFromArgs(args: GrepArgs): GrepSearch {
  const glob = args.glob?.trim();
  const search: GrepSearch = {
    pattern: args.pattern,
    path: args.path?.trim() ? args.path.trim() : ".",
    ignoreCase: args.ignoreCase === true,
    literal: args.literal === true,
    context: clampInt(args.context, 0, GREP_MAX_CONTEXT, 0),
    outputMode: args.outputMode === "files" ? "files" : "content",
  };
  if (glob) search.glob = glob;
  return search;
}

export function assertCursorCompatible(args: GrepArgs, search: GrepSearch): void {
  const mismatch = "cursor does not match this search; pass the same query fields and the cursor from the previous result";
  if (args.pattern !== search.pattern) throw new Error(mismatch);
  if (args.path !== undefined && (args.path.trim() || ".") !== search.path) throw new Error(mismatch);
  if (args.glob !== undefined && (args.glob.trim() || undefined) !== search.glob) throw new Error(mismatch);
  if (args.ignoreCase !== undefined && args.ignoreCase !== search.ignoreCase) throw new Error(mismatch);
  if (args.literal !== undefined && args.literal !== search.literal) throw new Error(mismatch);
  if (args.context !== undefined && clampInt(args.context, 0, GREP_MAX_CONTEXT, 0) !== search.context) {
    throw new Error(mismatch);
  }
  if (args.outputMode !== undefined && (args.outputMode === "files" ? "files" : "content") !== search.outputMode) {
    throw new Error(mismatch);
  }
}

export function encodeGrepCursor(cursor: GrepCursor): string {
  return `${CURSOR_PREFIX}${Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")}`;
}

export function decodeGrepCursor(value: string): GrepCursor {
  if (!value.startsWith(CURSOR_PREFIX)) throw new Error("Invalid grep cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid grep cursor");
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as GrepCursor).v !== 1) {
    throw new Error("Invalid grep cursor");
  }
  const cursor = parsed as GrepCursor;
  if (typeof cursor.offset !== "number" || cursor.offset < 0 || typeof cursor.search?.pattern !== "string") {
    throw new Error("Invalid grep cursor");
  }
  return cursor;
}

export function parseGitStatus(porcelain: string): Map<string, number> {
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

export function orderMatches(
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

export function uniqueFiles(matches: GrepMatch[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    if (seen.has(match.file)) continue;
    seen.add(match.file);
    files.push(match.file);
  }
  return files;
}

export function fileTotals(matches: GrepMatch[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const match of matches) totals.set(match.file, (totals.get(match.file) ?? 0) + 1);
  return totals;
}

function detailsFor(options: {
  totalMatches: number;
  totalFiles: number;
  offset: number;
  shown: number;
  scanCapped: boolean;
  search: GrepSearch;
  more: boolean;
}): GrepDetails {
  const details: GrepDetails = {
    totalMatches: options.totalMatches,
    totalFiles: options.totalFiles,
    offset: options.offset,
    shown: options.shown,
    scanCapped: options.scanCapped,
  };
  if (options.more) {
    details.nextCursor = encodeGrepCursor({ v: 1, search: options.search, offset: options.offset + options.shown });
  }
  return details;
}

function emptyResult(details: GrepDetails, scanCapped: boolean): { content: string; details: GrepDetails } {
  const notices = scanCapped ? [`scan capped at ${GREP_SCAN_CAP} matches; refine the pattern or glob`] : [];
  return { content: ["No matches found.", ...notices].filter(Boolean).join("\n"), details };
}

export function presentFilesPage(options: {
  ordered: GrepMatch[];
  offset: number;
  limit: number;
  search: GrepSearch;
  scanCapped: boolean;
}): { content: string; details: GrepDetails } {
  const totals = fileTotals(options.ordered);
  const files = uniqueFiles(options.ordered);
  const page = files.slice(options.offset, options.offset + options.limit);
  const details = detailsFor({
    totalMatches: options.ordered.length,
    totalFiles: files.length,
    offset: options.offset,
    shown: page.length,
    scanCapped: options.scanCapped,
    search: options.search,
    more: options.offset + page.length < files.length,
  });
  if (options.ordered.length === 0) return emptyResult(details, options.scanCapped);
  const header = `${details.totalMatches} matches in ${details.totalFiles} files. Showing files ${
    options.offset + 1
  }–${options.offset + page.length}, ranked by git changes then recency.`;
  const body = page.map((file) => `${file} (${totals.get(file) ?? 0})`);
  const extra = options.scanCapped ? ["", `scan capped at ${GREP_SCAN_CAP} matches; refine the pattern or glob`] : [];
  const footer = details.nextCursor ? ["", `[Continue with cursor="${details.nextCursor}"]`] : [];
  return { content: [header, "", ...body, ...extra, ...footer].join("\n"), details };
}

export function presentContentPage(options: {
  ordered: GrepMatch[];
  offset: number;
  limit: number;
  search: GrepSearch;
  scanCapped: boolean;
  renderLine?: (match: GrepMatch) => string;
}): { content: string; details: GrepDetails } {
  const totals = fileTotals(options.ordered);
  const files = uniqueFiles(options.ordered);
  const page = options.ordered.slice(options.offset, options.offset + options.limit);
  const details = detailsFor({
    totalMatches: options.ordered.length,
    totalFiles: files.length,
    offset: options.offset,
    shown: page.length,
    scanCapped: options.scanCapped,
    search: options.search,
    more: options.offset + page.length < options.ordered.length,
  });
  if (options.ordered.length === 0) return emptyResult(details, options.scanCapped);

  const prior = new Map<string, number>();
  for (let index = 0; index < options.offset; index++) {
    const file = options.ordered[index]!.file;
    prior.set(file, (prior.get(file) ?? 0) + 1);
  }
  const header = `${details.totalMatches} matches in ${details.totalFiles} files. Showing ${options.offset + 1}–${
    options.offset + page.length
  }, ranked by git changes then recency.`;
  const render = options.renderLine ?? defaultRender;
  const blocks: string[] = [];
  let index = 0;
  while (index < page.length) {
    const file = page[index]!.file;
    let count = 0;
    while (index + count < page.length && page[index + count]!.file === file) count++;
    const start = (prior.get(file) ?? 0) + 1;
    const end = start + count - 1;
    const total = totals.get(file) ?? count;
    const noun = total === 1 ? "match" : "matches";
    const range = start === 1 && end === total ? `${total} ${noun}` : `${total} ${noun}, showing ${start}–${end}`;
    const chunk = page.slice(index, index + count);
    blocks.push(`${file} (${range})`, ...groupRendered(chunk, render));
    index += count;
  }
  const extra = options.scanCapped ? ["", `scan capped at ${GREP_SCAN_CAP} matches; refine the pattern or glob`] : [];
  const footer = details.nextCursor ? ["", `[Continue with cursor="${details.nextCursor}"]`] : [];
  return { content: [header, "", ...blocks, ...extra, ...footer].join("\n"), details };
}

function defaultRender(match: GrepMatch): string {
  return `  ${match.line}: ${clipLine(match.text)}`;
}

function groupRendered(chunk: GrepMatch[], renderLine: (match: GrepMatch) => string): string[] {
  const lines: string[] = [];
  for (const match of chunk) {
    for (const line of renderLine(match).split("\n")) {
      if (line.length > 0) lines.push(line);
    }
  }
  return lines;
}

export async function renderMatchWithContext(
  root: string,
  page: GrepMatch[],
  context: number,
): Promise<(match: GrepMatch) => string> {
  if (context <= 0) return defaultRender;
  const cache = new Map<string, string[]>();
  const read = async (file: string): Promise<string[]> => {
    const cached = cache.get(file);
    if (cached) return cached;
    try {
      const content = await readFile(path.join(root, file), "utf8");
      const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      cache.set(file, lines);
      return lines;
    } catch {
      cache.set(file, []);
      return [];
    }
  };
  const windows = new Map<string, string>();
  const byFile = new Map<string, GrepMatch[]>();
  for (const match of page) {
    const list = byFile.get(match.file) ?? [];
    list.push(match);
    byFile.set(match.file, list);
  }
  for (const [file, hits] of byFile) {
    const lines = await read(file);
    const shown = new Map<number, { text: string; hit: boolean }>();
    for (const hit of hits) {
      if (lines.length === 0) {
        shown.set(hit.line, { text: hit.text, hit: true });
        continue;
      }
      const start = Math.max(1, hit.line - context);
      const end = Math.min(lines.length, hit.line + context);
      for (let line = start; line <= end; line++) {
        const current = shown.get(line);
        shown.set(line, {
          text: lines[line - 1] ?? "",
          hit: Boolean(current?.hit) || line === hit.line,
        });
      }
    }
    const orderedLines = [...shown.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([line, value]) => `  ${line}${value.hit ? ":" : "-"} ${clipLine(value.text)}`);
    windows.set(file, orderedLines.join("\n"));
  }
  const emitted = new Set<string>();
  return (match: GrepMatch) => {
    if (emitted.has(match.file)) return "";
    emitted.add(match.file);
    return windows.get(match.file) ?? defaultRender(match);
  };
}

interface RgMatchEvent {
  type: "match";
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

export function parseRgMatches(stdout: string, root: string): { matches: GrepMatch[]; scanCapped: boolean } {
  const matches: GrepMatch[] = [];
  let scanCapped = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    let event: RgMatchEvent;
    try {
      event = JSON.parse(line) as RgMatchEvent;
    } catch {
      continue;
    }
    if (event.type !== "match") continue;
    const absolute = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    if (!absolute || typeof lineNumber !== "number") continue;
    const file = posixRel(root, path.resolve(absolute));
    if (!file) continue;
    matches.push({ file, line: lineNumber, text: event.data?.lines?.text ?? "" });
    if (matches.length >= GREP_SCAN_CAP) {
      scanCapped = true;
      break;
    }
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
    "Search workspace text with ripgrep. Matches are grouped by file and ranked so git-changed and recently modified files come first, then paginated (default 20 matches, max 100). Use glob to narrow, outputMode=files for ranked paths only, and pass cursor unchanged to continue the same search. Hidden files are not searched; .gitignore is respected. Requires rg on PATH.",
  parameters: Type.Object({
    pattern: Type.String({ description: "Search pattern (regex, or a literal string when literal is true)." }),
    path: Type.Optional(Type.String({ description: "Directory or file to search; defaults to the workspace root." })),
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
      const target = await resolveWorkspacePath(context.rootPath, search.path);
      const rgArgs = ["--json", "--line-number", "--color", "never"];
      if (search.ignoreCase) rgArgs.push("--ignore-case");
      if (search.literal) rgArgs.push("--fixed-strings");
      if (search.glob) rgArgs.push("--glob", search.glob);
      rgArgs.push("--", search.pattern, target);
      let stdout: string;
      try {
        const result = await runProcess("rg", rgArgs, {
          cwd: context.rootPath,
          signal: context.signal,
          allowExitCodes: [0, 1],
          maxOutputBytes: GREP_SCAN_BYTES,
        });
        stdout = result.stdout.toString("utf8");
      } catch (error) {
        if (error instanceof ProcessError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("ripgrep (rg) was not found on PATH");
        throw error;
      }
      const parsed = parseRgMatches(stdout, context.rootPath);
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
