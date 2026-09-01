import { lstat, readFile, writeFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { workspacePathClaim } from "./execution.js";
import { resolveWorkspacePath } from "./path-safety.js";
import type { AgentTool, ToolResult } from "./types.js";

export type EditArgs = {
  path: string;
  oldText: string;
  newText: string;
};

function ok(content: string): ToolResult {
  return { content, isError: false };
}

function fail(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true };
}

export function splitBom(text: string): { bom: string; text: string } {
  if (text.charCodeAt(0) === 0xfeff) return { bom: "\uFEFF", text: text.slice(1) };
  return { bom: "", text };
}

export function detectLineEnding(text: string): "\r\n" | "\n" | "\r" {
  if (text.includes("\r\n")) return "\r\n";
  if (text.includes("\r")) return "\r";
  return "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n" | "\r"): string {
  if (ending === "\n") return text;
  return text.replace(/\n/g, ending);
}

export function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const at = content.indexOf(needle, from);
    if (at < 0) return count;
    count++;
    from = at + needle.length;
  }
}

export const editTool: AgentTool<EditArgs> = {
  name: "edit",
  description:
    "Replace one exact, unique text occurrence in an existing workspace file. oldText must match the file exactly once; copy it from read (line endings are matched even if the file uses CRLF). Prefer this over write for partial changes. Does not create files.",
  parameters: Type.Object({
    path: Type.String({ description: "Existing file to edit." }),
    oldText: Type.String({ description: "Exact text to replace; must occur once in the file." }),
    newText: Type.String({ description: "Replacement text. Empty string deletes the match." }),
  }),
  replay: "never",
  execution: {
    effect: "write",
    mode: "parallel",
    resources: async (args, context) => [
      await workspacePathClaim(context.rootPath, args.path, "write", { forWrite: true }),
    ],
  },
  async execute(args, context) {
    try {
      context.signal.throwIfAborted();
      const inputPath = args.path.trim();
      if (!inputPath) throw new Error("path cannot be empty");
      const oldText = normalizeToLF(args.oldText);
      const newText = normalizeToLF(args.newText);
      if (!oldText) throw new Error("oldText cannot be empty");
      if (oldText === newText) throw new Error("oldText and newText are identical; nothing to change");

      const target = await resolveWorkspacePath(context.rootPath, inputPath, true);
      let info;
      try {
        info = await lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`File not found: ${inputPath}`);
        }
        throw error;
      }
      if (info.isDirectory() || !info.isFile()) throw new Error(`Not a file: ${inputPath}`);

      const buffer = await readFile(target);
      if (buffer.includes(0)) throw new Error(`Binary file (${info.size} bytes): ${inputPath}`);

      const { bom, text } = splitBom(buffer.toString("utf8"));
      const ending = detectLineEnding(text);
      const content = normalizeToLF(text);
      const first = content.indexOf(oldText);
      if (first < 0) {
        throw new Error(
          "oldText was not found. Re-read the file and copy the exact text; whitespace must match.",
        );
      }
      if (content.indexOf(oldText, first + oldText.length) >= 0) {
        throw new Error(
          `oldText occurs ${countOccurrences(content, oldText)} times; include more surrounding lines to make it unique`,
        );
      }

      const next = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
      await writeFile(target, `${bom}${restoreLineEndings(next, ending)}`, "utf8");
      return ok(`Replaced 1 occurrence in ${inputPath}`);
    } catch (error) {
      return fail(error);
    }
  },
};
