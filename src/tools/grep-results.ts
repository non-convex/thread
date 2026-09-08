import { readFile } from "node:fs/promises";
import path from "node:path";

export const GREP_DEFAULT_LIMIT = 20;
export const GREP_MAX_LIMIT = 100;
export const GREP_SCAN_CAP = 2_000;
const GREP_MAX_LINE_CHARS = 200;
export const GREP_MAX_CONTEXT = 5;
export const GREP_SCAN_BYTES = 8 * 1024 * 1024;
const CURSOR_PREFIX = "g1.";
const SCAN_LIMIT_NOTICE = `scan capped at ${GREP_SCAN_CAP} matches or ${GREP_SCAN_BYTES / 1024 / 1024}MB of ripgrep output; refine the pattern or glob`;

type GrepOutputMode = "content" | "files";

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

interface GrepSearch {
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

interface GrepCursor {
  v: 1;
  search: GrepSearch;
  offset: number;
}

export function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clipLine(text: string): string {
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

function encodeGrepCursor(cursor: GrepCursor): string {
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

function uniqueFiles(matches: GrepMatch[]): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    if (seen.has(match.file)) continue;
    seen.add(match.file);
    files.push(match.file);
  }
  return files;
}

function fileTotals(matches: GrepMatch[]): Map<string, number> {
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
  const notices = scanCapped ? [SCAN_LIMIT_NOTICE] : [];
  return { content: [scanCapped ? "No complete matches collected before the scan limit." : "No matches found.", ...notices].join("\n"), details };
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
  const extra = options.scanCapped ? ["", SCAN_LIMIT_NOTICE] : [];
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
  const extra = options.scanCapped ? ["", SCAN_LIMIT_NOTICE] : [];
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
  const read = async (file: string): Promise<string[]> => {
    try {
      const content = await readFile(path.join(root, file), "utf8");
      const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      return lines;
    } catch {
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
