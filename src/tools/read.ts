import { createReadStream } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Type } from "@earendil-works/pi-ai";
import { resolveWorkspacePath } from "./path-safety.js";
import type { AgentTool, ToolResult } from "./types.js";

export const READ_DEFAULT_LIMIT = 2_000;
export const READ_MAX_LIMIT = 5_000;
export const READ_MAX_BYTES = 64 * 1024;
const SLURP_MAX_BYTES = 1024 * 1024;
const SNIFF_BYTES = 8_192;

export type ReadArgs = {
  path: string;
  offset?: number;
  limit?: number;
};

export interface ReadDetails {
  offset: number;
  shown: number;
  total?: number;
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

function ok(content: string, details?: ReadDetails): ToolResult {
  return { content, isError: false, ...(details === undefined ? {} : { details }) };
}

function fail(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true };
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function presentRead(page: ReadWindow): { content: string; details: ReadDetails } {
  const shown = page.window.length;
  const details: ReadDetails = { offset: page.offset, shown };
  if (page.total !== undefined) details.total = page.total;
  if (shown === 0) return { content: "(empty file)", details: { offset: page.offset, shown: 0, total: 0 } };

  const body = page.window.join("\n");
  const complete = page.hitEnd && !page.truncatedByBytes;
  if (complete) return { content: body, details };

  const start = page.offset;
  const end = page.offset + shown - 1;
  const range = page.total !== undefined ? `Showing lines ${start}–${end} of ${page.total}` : `Showing lines ${start}–${end}`;
  const reason = page.truncatedByBytes ? " (64KB limit)" : "";
  return {
    content: `${body}\n\n[${range}${reason}. Use offset=${end + 1} to continue.]`,
    details,
  };
}

function windowFromLines(lines: string[], offset: number, limit: number): ReadWindow {
  const start = offset - 1;
  if (start >= lines.length) {
    return { window: [], offset, hitEnd: true, truncatedByBytes: false, scannedLines: lines.length, total: lines.length };
  }
  const window: string[] = [];
  let bytes = 0;
  let truncatedByBytes = false;
  let firstLineBytes: number | undefined;
  for (let index = start; index < lines.length && window.length < limit; index++) {
    const line = lines[index]!;
    const extra = Buffer.byteLength(line, "utf8") + (window.length > 0 ? 1 : 0);
    if (bytes + extra > READ_MAX_BYTES) {
      truncatedByBytes = true;
      if (window.length === 0) firstLineBytes = Buffer.byteLength(line, "utf8");
      break;
    }
    window.push(line);
    bytes += extra;
  }
  const page: ReadWindow = {
    window,
    offset,
    hitEnd: !truncatedByBytes && start + window.length >= lines.length,
    truncatedByBytes,
    scannedLines: lines.length,
    total: lines.length,
  };
  if (firstLineBytes !== undefined) page.firstLineBytes = firstLineBytes;
  return page;
}

async function hasNulPrefix(target: string, size: number): Promise<boolean> {
  const length = Math.min(SNIFF_BYTES, size);
  if (length <= 0) return false;
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

async function streamWindow(
  target: string,
  offset: number,
  limit: number,
  signal: AbortSignal,
): Promise<ReadWindow> {
  const stream = createReadStream(target, { encoding: "utf8" });
  stream.on("error", () => undefined);
  const readline = createInterface({ input: stream, crlfDelay: Infinity });
  const onAbort = () => {
    readline.close();
    stream.destroy();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    signal.throwIfAborted();
    const window: string[] = [];
    let bytes = 0;
    let lineNo = 0;
    let hitEnd = true;
    let truncatedByBytes = false;
    let firstLineBytes: number | undefined;
    for await (const line of readline) {
      lineNo++;
      if (lineNo < offset) continue;
      if (window.length === limit) {
        hitEnd = false;
        break;
      }
      const extra = Buffer.byteLength(line, "utf8") + (window.length > 0 ? 1 : 0);
      if (bytes + extra > READ_MAX_BYTES) {
        truncatedByBytes = true;
        hitEnd = false;
        if (window.length === 0) firstLineBytes = Buffer.byteLength(line, "utf8");
        break;
      }
      window.push(line);
      bytes += extra;
    }
    const page: ReadWindow = { window, offset, hitEnd, truncatedByBytes, scannedLines: lineNo };
    if (hitEnd) page.total = lineNo;
    if (firstLineBytes !== undefined) page.firstLineBytes = firstLineBytes;
    return page;
  } finally {
    signal.removeEventListener("abort", onAbort);
    readline.close();
    stream.destroy();
  }
}

export const readTool: AgentTool<ReadArgs> = {
  name: "read",
  description:
    "Read a UTF-8 text file inside the workspace. Large files are returned in line pages (default 2000 lines, 64KB) with a continuation offset. Binary files are rejected. Does not add line numbers.",
  parameters: Type.Object({
    path: Type.String({ description: "File to read." }),
    offset: Type.Optional(
      Type.Integer({ minimum: 1, description: "1-indexed line to start from; default 1." }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: READ_MAX_LIMIT,
        description: `Maximum lines to return; default ${READ_DEFAULT_LIMIT}.`,
      }),
    ),
  }),
  replay: "safe",
  async execute(args, context) {
    try {
      context.signal.throwIfAborted();
      const inputPath = args.path.trim();
      if (!inputPath) throw new Error("path cannot be empty");
      const offset = clampInt(args.offset, 1, Number.MAX_SAFE_INTEGER, 1);
      const limit = clampInt(args.limit, 1, READ_MAX_LIMIT, READ_DEFAULT_LIMIT);
      const target = await resolveWorkspacePath(context.rootPath, inputPath);
      const info = await stat(target);
      if (info.isDirectory() || !info.isFile()) throw new Error(`Not a file: ${inputPath}`);
      if (info.size === 0) return ok("(empty file)", { offset, shown: 0, total: 0 });

      let page: ReadWindow;
      if (info.size <= SLURP_MAX_BYTES) {
        const buffer = await readFile(target);
        if (buffer.includes(0)) throw new Error(`Binary file (${info.size} bytes): ${inputPath}`);
        page = windowFromLines(splitLines(buffer.toString("utf8")), offset, limit);
      } else {
        if (await hasNulPrefix(target, info.size)) {
          throw new Error(`Binary file (${info.size} bytes): ${inputPath}`);
        }
        page = await streamWindow(target, offset, limit, context.signal);
      }

      if (page.firstLineBytes !== undefined) {
        throw new Error(`Line ${offset} is ${page.firstLineBytes} bytes, exceeds the 64KB limit.`);
      }
      if (page.window.length === 0) {
        if (offset <= 1) return ok("(empty file)", { offset, shown: 0, total: 0 });
        const total = page.total ?? page.scannedLines;
        throw new Error(`Offset ${offset} is beyond end of file (${total} lines total)`);
      }
      const presented = presentRead(page);
      return ok(presented.content, presented.details);
    } catch (error) {
      return fail(error);
    }
  },
};
