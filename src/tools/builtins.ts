import { lstat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { workspacePathClaim } from "./execution.js";
import { resolveWorkspacePath } from "./path-safety.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { grepTool } from "./grep.js";
import { listTool } from "./list.js";
import { readTool } from "./read.js";
import { ToolRegistry, type AgentTool, type ToolResult } from "./types.js";
import { webFetchTool, webSearchTool } from "./web.js";

function ok(content: string, details?: unknown): ToolResult {
  return { content, isError: false, ...(details === undefined ? {} : { details }) };
}

function fail(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true };
}

export const writeTool: AgentTool<{ path: string; content: string }> = {
  name: "write",
  description:
    "Create a new UTF-8 file or completely replace an existing one. Prefer edit for partial changes to a file that already exists.",
  parameters: Type.Object({
    path: Type.String({ description: "File to create or replace." }),
    content: Type.String({ description: "Full file contents." }),
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
      const target = await resolveWorkspacePath(context.rootPath, inputPath, { forWrite: true });
      let existed = false;
      try {
        const info = await lstat(target);
        if (info.isDirectory() || !info.isFile()) throw new Error(`Not a file: ${inputPath}`);
        existed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, args.content, "utf8");
      const bytes = Buffer.byteLength(args.content, "utf8");
      return ok(`${existed ? "Overwrote" : "Created"} ${inputPath} (${bytes} bytes)`);
    } catch (error) {
      return fail(error);
    }
  },
};

export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const tool of [readTool, listTool, grepTool, writeTool, editTool, bashTool, webSearchTool, webFetchTool]) {
    registry.register(tool);
  }
}

export function registerImplementationWorkerTools(registry: ToolRegistry): void {
  for (const tool of [readTool, listTool, grepTool, writeTool, editTool, bashTool]) registry.register(tool);
}
