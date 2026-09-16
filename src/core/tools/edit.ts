import { Type } from "@earendil-works/pi-ai";
import { prepareFilePath, workspacePathClaim } from "./execution.js";
import { updateFile } from "./file-write.js";
import { fileDiff, type FileDiffDetails } from "./file-diff.js";
import type { AgentTool } from "./types.js";

type EditArgs = {
  path: string;
  edits: { oldText: string; newText: string }[];
};

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export const editTool: AgentTool<EditArgs> = {
  name: "edit",
  description:
    "Edit an existing UTF-8 workspace file with one or more exact text replacements. Use one edits array for separate changes in the same file. Every oldText must match a unique, non-overlapping region of the original file, not the result of earlier edits. Copy only enough context from read to make each match unique. Line ending differences are tolerated; other whitespace and characters must match. All edits are checked before writing. Content outside the matched regions is preserved. Prefer this over write for partial changes. Does not create files.",
  parameters: Type.Object({
    path: Type.String({ minLength: 1, description: "Existing file to edit." }),
    edits: Type.Array(Type.Object({
      oldText: Type.String({ minLength: 1, description: "Exact text to replace; must occur once in the original file." }),
      newText: Type.String({ description: "Replacement text. Empty string deletes the match." }),
    }, { additionalProperties: false }), {
      minItems: 1,
      description: "Non-overlapping replacements in one file. Merge overlapping or nested changes into one edit.",
    }),
  }, { additionalProperties: false }),
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
      if (!Array.isArray(args.edits) || args.edits.length === 0) throw new Error("edits must contain at least one replacement");

      let changes: FileDiffDetails = {};
      await updateFile(context, inputPath, (before) => {
        if (!before) throw new Error(`File not found: ${inputPath}`);
        const buffer = before.content;
        if (buffer.includes(0)) throw new Error(`Binary file (${buffer.length} bytes): ${inputPath}`);

        const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
        const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
        const content = source.slice(bom.length);
        const defaultEnding = content.match(/\r\n|\r|\n/)?.[0] ?? "\n";
        const replacements = args.edits.map((edit, index) => {
          const oldText = normalizeToLF(edit.oldText);
          const newText = normalizeToLF(edit.newText);
          if (!oldText) throw new Error(`edits[${index}].oldText cannot be empty`);
          if (oldText === newText) throw new Error(`edits[${index}] has identical oldText and newText; nothing to change`);

          const pattern = oldText.split("\n")
            .map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("(?:\\r\\n|\\r(?!\\n)|(?<!\\r)\\n)");
          // Lookahead detects overlapping matches; newline alternatives keep CRLF indivisible.
          const matches = content.matchAll(new RegExp(`(?=(${pattern}))`, "gu"));
          const first = matches.next().value;
          if (!first) throw new Error(`edits[${index}].oldText was not found. Re-read the file and copy the exact text; whitespace must match except for line endings.`);
          if (!matches.next().done) throw new Error(`edits[${index}].oldText matches multiple locations; include more surrounding text to make it unique.`);
          const matched = first[1]!;
          const ending = matched.match(/\r\n|\r|\n/)?.[0] ?? defaultEnding;
          return { index, start: first.index, end: first.index + matched.length, text: newText.replace(/\n/g, ending) };
        }).sort((left, right) => left.start - right.start);

        const parts = [bom];
        let end = 0;
        for (const [index, replacement] of replacements.entries()) {
          if (replacement.start < end) throw new Error(`edits[${replacements[index - 1]!.index}] and edits[${replacement.index}] overlap. Merge them into one edit.`);
          parts.push(content.slice(end, replacement.start), replacement.text);
          end = replacement.end;
        }
        parts.push(content.slice(end));
        const updated = Buffer.from(parts.join(""), "utf8");
        changes = fileDiff(inputPath, buffer, updated);
        return updated;
      });
      return { content: `Applied ${args.edits.length} edit(s) to ${inputPath}`, isError: false,
        details: { edits: args.edits.length, ...changes } };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  },
};
