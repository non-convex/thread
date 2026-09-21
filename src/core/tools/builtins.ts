import { Type } from "@earendil-works/pi-ai";
import { prepareFilePath, fileAccess } from "./execution.js";
import { updateFile } from "./file-write.js";
import { fileDiff, type FileDiffDetails } from "./file-diff.js";
import { bashTool } from "./bash.js";
import { editTool } from "./edit.js";
import { grepTool } from "./grep.js";
import { listTool } from "./list.js";
import { readTool } from "./read.js";
import { viewImageTool } from "./view-image.js";
import type { ToolRegistry, AgentTool } from "./types.js";
import { ok, fail } from "./results.js";
import { webFetchTool, webSearchTool } from "./web.js";

export const writeTool: AgentTool<{ path: string; content: string }> = {
  name: "write",
  description:
    "Create a new UTF-8 file or completely replace an existing one. Before overwriting, read the file in an earlier model step; if it changed since that read, re-read it and regenerate the write. Your successful writes remain current without reading them back. Prefer edit for partial changes to a file that already exists.",
  parameters: Type.Object({
    path: Type.String({ description: "File to create or replace." }),
    content: Type.String({ description: "Full file contents." }),
  }),
  replay: "never",
  prepare: (args, context) => prepareFilePath(args, context, { forWrite: true }),
  execution: fileAccess("write"),
  async execute(args, context) {
    try {
      context.signal.throwIfAborted();
      const inputPath = args.path;
      if (!inputPath) throw new Error("path cannot be empty");
      let changes: FileDiffDetails = {};
      const { existed, bytes, fileObservation } = await updateFile(context, inputPath, (before) => {
        const updated = Buffer.from(args.content, "utf8");
        changes = fileDiff(inputPath, before?.content, updated);
        return updated;
      }, { requireRead: true });
      return { ...ok(`${existed ? "Overwrote" : "Created"} ${inputPath} (${bytes} bytes)`, { existed, bytes, ...changes }),
        ...(fileObservation ? { fileObservation } : {}) };
    } catch (error) {
      return fail(error);
    }
  },
};

const BUILTIN_TOOLS = {
  read: readTool,
  view_image: viewImageTool,
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

export function registerWorkerTools(registry: ToolRegistry): void {
  for (const tool of [readTool, viewImageTool, listTool, grepTool, writeTool, editTool, bashTool]) registry.register(tool);
}
