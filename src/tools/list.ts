import { readdir } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { workspacePathClaim } from "./execution.js";
import { resolveWorkspacePath } from "./path-safety.js";
import type { AgentTool, ToolResult } from "./types.js";

export const LIST_DEFAULT_LIMIT = 200;
export const LIST_MAX_LIMIT = 1000;
const MODEL_OUTPUT_LIMIT = 64 * 1024;

export type ListKind = "d" | "l" | "f";

export type ListArgs = {
  path?: string;
  limit?: number;
};

export interface ListEntry {
  kind: ListKind;
  name: string;
}

export interface ListDetails {
  total: number;
  shown: number;
}

function ok(content: string, details?: ListDetails): ToolResult {
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

export function presentList(entries: ListEntry[], limit: number): { content: string; details: ListDetails } {
  const total = entries.length;
  if (total === 0) return { content: "(empty directory)", details: { total: 0, shown: 0 } };

  const shown = Math.min(total, limit);
  const page = entries.slice(0, shown);
  const body = page.map((entry) => `${entry.kind} ${entry.name}`).join("\n");
  const header = total === shown ? `${total} ${total === 1 ? "entry" : "entries"}` : `${total} entries. Showing 1–${shown}.`;
  const remaining = total - shown;
  const nextLimit = Math.min(LIST_MAX_LIMIT, Math.max(limit * 2, limit + 1));
  const footer =
    remaining > 0
      ? `\n\n[${remaining} more; ${
          limit < LIST_MAX_LIMIT ? `pass limit=${nextLimit} or list a subdirectory` : "list a subdirectory"
        }]`
      : "";
  return {
    content: `${header}\n\n${body}${footer}`,
    details: { total, shown },
  };
}

export const listTool: AgentTool<ListArgs> = {
  name: "list",
  description:
    "List one workspace directory. Does not recurse. Large directories are capped (default 200 entries) and the remainder is reported. Gitignored names are included.",
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "Directory to list; defaults to the workspace root." })),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: LIST_MAX_LIMIT,
        description: `Maximum entries to return; default ${LIST_DEFAULT_LIMIT}.`,
      }),
    ),
  }),
  replay: "safe",
  execution: {
    effect: "read",
    mode: "parallel",
    resources: async (args, context) => [
      await workspacePathClaim(context.rootPath, args.path?.trim() || ".", "read", { scope: "subtree" }),
    ],
  },
  async execute(args, context) {
    try {
      context.signal.throwIfAborted();
      const inputPath = args.path?.trim() ? args.path.trim() : ".";
      const target = await resolveWorkspacePath(context.rootPath, inputPath);
      const limit = clampInt(args.limit, 1, LIST_MAX_LIMIT, LIST_DEFAULT_LIMIT);
      let dirents;
      try {
        dirents = await readdir(target, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTDIR") {
          throw new Error(`Not a directory: ${inputPath}`);
        }
        throw error;
      }
      const entries = dirents
        .map((entry): ListEntry => ({
          kind: entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f",
          name: entry.name,
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      const presented = presentList(entries, limit);
      return ok(limited(presented.content), presented.details);
    } catch (error) {
      return fail(error);
    }
  },
};
