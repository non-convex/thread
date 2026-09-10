import { Type } from "@earendil-works/pi-ai";
import { prepareFilePath, workspacePathClaim } from "./execution.js";
import { updateFile } from "./file-write.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { grepTool } from "./grep.js";
import { listTool } from "./list.js";
import { readTool } from "./read.js";
import type { ToolRegistry, AgentTool, ToolResult } from "./types.js";
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
  prepare: (args, context) => prepareFilePath(args, context, { forWrite: true }),
  execution: {
    effect: "write",
    mode: "parallel",
    resources: async (args, context) => [
      await workspacePathClaim(context.rootPath, args.path, "write", {
        forWrite: true,
        ...(context.writableExternalPaths
          ? { allowedOutsidePaths: context.writableExternalPaths }
          : {}),
      }),
    ],
  },
  async execute(args, context) {
    try {
      context.signal.throwIfAborted();
      const inputPath = args.path;
      if (!inputPath) throw new Error("path cannot be empty");
      const { existed, bytes } = await updateFile(context, inputPath, () => Buffer.from(args.content, "utf8"));
      return ok(`${existed ? "Overwrote" : "Created"} ${inputPath} (${bytes} bytes)`);
    } catch (error) {
      return fail(error);
    }
  },
};

const BUILTIN_TOOLS = {
  read: readTool,
  list: listTool,
  grep: grepTool,
  write: writeTool,
  edit: editTool,
  bash: bashTool,
  websearch: webSearchTool,
  webfetch: webFetchTool,
} as const satisfies Record<string, AgentTool>;

export type BuiltinToolName = keyof typeof BUILTIN_TOOLS;

export function builtinTool(name: BuiltinToolName): AgentTool {
  if (!Object.hasOwn(BUILTIN_TOOLS, name)) throw new Error(`Unknown builtin tool: ${name}`);
  return BUILTIN_TOOLS[name];
}

export function registerImplementationWorkerTools(registry: ToolRegistry): void {
  for (const tool of [readTool, listTool, grepTool, writeTool, editTool, bashTool]) registry.register(tool);
}
