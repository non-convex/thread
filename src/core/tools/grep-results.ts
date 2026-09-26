import { readFile } from "node:fs/promises";
import { resolveToolPath } from "./execution.js";
import type { ToolContext } from "./types.js";
import { clampInt } from "./results.js";

export const GREP_DEFAULT_LIMIT = 20;
export const GREP_MAX_LIMIT = 100;
export const GREP_SCAN_CAP = 2_000;
const GREP_MAX_LINE_CHARS = 200;
export const GREP_MAX_CONTEXT = 5;
export const GREP_SCAN_BYTES = 8 * 1024 * 1024;
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
  offset?: number;
};
export type GrepSearch = Required<Omit<GrepArgs, "glob" | "limit" | "offset">> & Pick<GrepArgs, "glob">;
export interface GrepMatch { file: string; line: number; text: string }
export interface GrepDetails {
  totalMatches: number;
  totalFiles: number;
  offset: number;
  shown: number;
  scanCapped: boolean;
  nextOffset?: number;
}
interface PageOptions {
  ordered: GrepMatch[];
  offset: number;
  limit: number;
  outputMode: GrepOutputMode;
  scanCapped: boolean;
  renderLine?: (match: GrepMatch) => string;
}

function clipLine(text: string): string {
  const cleaned = text.replace(/\r/g, "").replace(/\n$/, "");
  return cleaned.length <= GREP_MAX_LINE_CHARS ? cleaned : `${cleaned.slice(0, GREP_MAX_LINE_CHARS)}…`;
}

export function searchFromArgs(args: GrepArgs): GrepSearch {
  const glob = args.glob?.trim();
  return {
    pattern: args.pattern, path: args.path?.trim() || ".", ignoreCase: args.ignoreCase === true,
    literal: args.literal === true, context: clampInt(args.context, 0, GREP_MAX_CONTEXT, 0),
    outputMode: args.outputMode === "files" ? "files" : "content", ...(glob ? { glob } : {}),
  };
}

function fileTotals(matches: GrepMatch[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const match of matches) totals.set(match.file, (totals.get(match.file) ?? 0) + 1);
  return totals;
}

export function presentPage(options: PageOptions): { content: string; details: GrepDetails } {
  const { ordered, offset, limit, outputMode, scanCapped } = options;
  const filesMode = outputMode === "files";
  const totals = fileTotals(ordered);
  const files = [...totals.keys()];
  const total = filesMode ? files.length : ordered.length;
  const shown = Math.max(0, Math.min(limit, total - offset));
  const details: GrepDetails = { totalMatches: ordered.length, totalFiles: files.length, offset, shown, scanCapped };
  if (offset + shown < total) {
    details.nextOffset = offset + shown;
  }
  const blocks = filesMode
    ? files.slice(offset, offset + limit).map((file) => `${file} (${totals.get(file)})`)
    : contentBlocks(options, totals);
  const pageRange = shown > 0
    ? `Showing ${filesMode ? "files " : ""}${offset + 1}–${offset + shown}, ranked by git changes then recency.`
    : `No ${filesMode ? "files" : "matches"} at offset ${offset}.`;
  const header = ordered.length
    ? `${ordered.length} matches in ${files.length} files. ${pageRange}`
    : scanCapped ? "No complete matches collected before the scan limit." : "No matches found.";
  return { content: [header, ...(ordered.length ? ["", ...blocks] : []),
    ...(scanCapped ? [...(ordered.length ? [""] : []), SCAN_LIMIT_NOTICE] : []),
    ...(details.nextOffset !== undefined ? ["", `[Continue with offset=${details.nextOffset}]`] : []),
  ].join("\n"), details };
}

function contentBlocks(options: PageOptions, totals: Map<string, number>): string[] {
  const page = options.ordered.slice(options.offset, options.offset + options.limit);
  const prior = fileTotals(options.ordered.slice(0, options.offset));
  const render = options.renderLine ?? defaultRender;
  const blocks: string[] = [];
  for (let index = 0; index < page.length;) {
    const file = page[index]!.file;
    let end = index + 1;
    while (end < page.length && page[end]!.file === file) end++;
    const start = (prior.get(file) ?? 0) + 1;
    const last = start + end - index - 1;
    const total = totals.get(file)!;
    const range = `${total} ${total === 1 ? "match" : "matches"}${start === 1 && last === total ? "" : `, showing ${start}–${last}`}`;
    blocks.push(`${file} (${range})`, ...page.slice(index, end).flatMap((match) => render(match).split("\n").filter(Boolean)));
    index = end;
  }
  return blocks;
}

function defaultRender(match: GrepMatch): string { return `  ${match.line}: ${clipLine(match.text)}`; }

export async function renderMatchWithContext(toolContext: ToolContext, page: GrepMatch[], context: number): Promise<(match: GrepMatch) => string> {
  if (context <= 0) return defaultRender;
  const windows = new Map<string, string>();
  for (const file of new Set(page.map((match) => match.file))) {
    const target = await resolveToolPath(toolContext, file);
    let lines: string[] = [];
    try {
      lines = (await readFile(target, { encoding: "utf8", signal: toolContext.signal })).replace(/\r\n?/g, "\n").split("\n");
    } catch { toolContext.signal.throwIfAborted(); }
    const shown = new Map<number, { text: string; hit: boolean }>();
    for (const hit of page.filter((match) => match.file === file)) {
      if (!lines.length) { shown.set(hit.line, { text: hit.text, hit: true }); continue; }
      for (let line = Math.max(1, hit.line - context); line <= Math.min(lines.length, hit.line + context); line++) {
        shown.set(line, { text: lines[line - 1] ?? "", hit: Boolean(shown.get(line)?.hit) || line === hit.line });
      }
    }
    windows.set(file, [...shown].sort(([a], [b]) => a - b)
      .map(([line, value]) => `  ${line}${value.hit ? ":" : "-"} ${clipLine(value.text)}`).join("\n"));
  }
  const emitted = new Set<string>();
  return (match) => {
    if (emitted.has(match.file)) return "";
    emitted.add(match.file);
    return windows.get(match.file) ?? defaultRender(match);
  };
}
