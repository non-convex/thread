import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Type } from "@earendil-works/pi-ai";
import { prepareFilePath, fileAccess, resolveToolPath } from "./execution.js";
import { ok, fail, clampInt } from "./results.js";
import type { AgentTool } from "./types.js";

export const READ_DEFAULT_LIMIT = 2_000;
export const READ_MAX_LIMIT = 5_000;
export const READ_MAX_BYTES = 64 * 1024;
const SLURP_MAX_BYTES = 1024 * 1024;
const SNIFF_BYTES = 8_192;
export type ReadArgs = { path: string; offset?: number; limit?: number };
export interface ReadDetails {
  offset: number;
  shown: number;
  total?: number;
  nextOffset?: number;
  truncatedByBytes?: boolean;
}
interface ReadWindow {
  window: string[];
  offset: number;
  hitEnd: boolean;
  truncatedByBytes: boolean;
  scannedLines: number;
  total?: number;
  firstLineBytes?: number;
}

export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function presentRead(page: ReadWindow): { content: string; details: ReadDetails } {
  const shown = page.window.length;
  const details: ReadDetails = { offset: page.offset, shown, ...(page.total !== undefined ? { total: page.total } : {}) };
  if (!shown) return { content: "(empty file)", details: { offset: page.offset, shown: 0, total: 0 } };
  const body = page.window.join("\n");
  if (page.hitEnd && !page.truncatedByBytes) return { content: body, details };
  const end = page.offset + shown - 1;
  const range = `Showing lines ${page.offset}–${end}${page.total !== undefined ? ` of ${page.total}` : ""}`;
  details.nextOffset = end + 1;
  if (page.truncatedByBytes) details.truncatedByBytes = true;
  return { content: `${body}\n\n[${range}${page.truncatedByBytes ? " (64KB limit)" : ""}. Use offset=${end + 1} to continue.]`, details };
}

/** The same line and byte limits apply to small-file and streaming reads. */
async function collectWindow(lines: Iterable<string> | AsyncIterable<string>, offset: number, limit: number, total?: number): Promise<ReadWindow> {
  const page: ReadWindow = { window: [], offset, hitEnd: true, truncatedByBytes: false,
    scannedLines: total === undefined ? 0 : Math.min(total, offset - 1), ...(total !== undefined ? { total } : {}) };
  let bytes = 0;
  for await (const line of lines) {
    if (++page.scannedLines < offset) continue;
    if (page.window.length === limit) { page.hitEnd = false; break; }
    const lineBytes = Buffer.byteLength(line, "utf8");
    const extra = lineBytes + Number(page.window.length > 0);
    if (bytes + extra > READ_MAX_BYTES) {
      page.hitEnd = false;
      page.truncatedByBytes = true;
      if (!page.window.length) page.firstLineBytes = lineBytes;
      break;
    }
    page.window.push(line);
    bytes += extra;
  }
  if (page.hitEnd) page.total ??= page.scannedLines;
  return page;
}

async function hasNulPrefix(target: string, size: number): Promise<boolean> {
  const length = Math.min(SNIFF_BYTES, size);
  if (!length) return false;
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally { await handle.close(); }
}

async function streamWindow(target: string, offset: number, limit: number, signal: AbortSignal): Promise<ReadWindow> {
  const stream = createReadStream(target, { encoding: "utf8" });
  stream.on("error", () => undefined);
  const readline = createInterface({ input: stream, crlfDelay: Infinity });
  const stop = () => { readline.close(); stream.destroy(); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    const page = await collectWindow(readline, offset, limit);
    signal.throwIfAborted();
    return page;
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
  }
}

export const readTool: AgentTool<ReadArgs> = {
  name: "read",
  description: `Read a UTF-8 text file. Absolute paths and paths outside the project are allowed. Returns up to ${READ_DEFAULT_LIMIT} lines by default, capped at 64KB. Use offset/limit for a relevant range; follow the continuation offset only when more content is needed. Binary files are rejected. Does not add line numbers.`,
  parameters: Type.Object({
    path: Type.String({ description: "File to read." }),
    offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line to start from; default 1." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: READ_MAX_LIMIT, description: `Maximum lines to return; default ${READ_DEFAULT_LIMIT}.` })),
  }),
  replay: "safe",
  prepare: (args, context) => prepareFilePath(args, context),
  execution: fileAccess("read"),
  async execute(args, context) {
    try {
      context.signal.throwIfAborted();
      if (!args.path) throw new Error("path cannot be empty");
      const offset = clampInt(args.offset, 1, Number.MAX_SAFE_INTEGER, 1);
      const limit = clampInt(args.limit, 1, READ_MAX_LIMIT, READ_DEFAULT_LIMIT);
      const target = await resolveToolPath(context, args.path);
      const info = await stat(target);
      if (!info.isFile()) throw new Error(`Not a file: ${args.path}`);
      if (!info.size) return ok("(empty file)", { offset, shown: 0, total: 0 });
      let page: ReadWindow;
      if (info.size <= SLURP_MAX_BYTES) {
        const buffer = await readFile(target, { signal: context.signal });
        if (buffer.includes(0)) throw new Error(`Binary file (${info.size} bytes): ${args.path}`);
        const lines = splitLines(buffer.toString("utf8"));
        page = await collectWindow(lines.slice(offset - 1), offset, limit, lines.length);
      } else {
        if (await hasNulPrefix(target, info.size)) throw new Error(`Binary file (${info.size} bytes): ${args.path}`);
        page = await streamWindow(target, offset, limit, context.signal);
      }
      if (page.firstLineBytes !== undefined) throw new Error(`Line ${offset} is ${page.firstLineBytes} bytes, exceeds the 64KB limit.`);
      if (!page.window.length && offset > 1) throw new Error(`Offset ${offset} is beyond end of file (${page.total ?? page.scannedLines} lines total)`);
      const presented = presentRead(page);
      return ok(presented.content, presented.details);
    } catch (error) { return fail(error); }
  },
};
