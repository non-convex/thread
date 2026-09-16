import { formatPatch, structuredPatch } from "diff";

export interface FileDiffDetails {
  diff?: string;
  additions?: number;
  deletions?: number;
  diffUnavailable?: string;
}

/** A bounded display artifact from the actual bytes involved in this write. */
export function fileDiff(filePath: string, before: Buffer | undefined, after: Buffer): FileDiffDetails {
  const maxBytes = 256 * 1024;
  if ((before?.length ?? 0) + after.length > maxBytes) return { diffUnavailable: "Diff omitted: file size exceeds preview budget" };
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const oldText = before ? decoder.decode(before) : "";
    const newText = decoder.decode(after);
    if (oldText.includes("\0") || newText.includes("\0")) return { diffUnavailable: "Diff unavailable for binary content" };
    const patch = structuredPatch(filePath, filePath, oldText, newText, undefined, undefined, { context: 2, timeout: 50 });
    if (!patch) return { diffUnavailable: "Diff omitted: computation exceeded preview budget" };
    const lines = patch.hunks.flatMap((hunk) => hunk.lines);
    return {
      diff: patch.hunks.length ? formatPatch(patch, { includeIndex: false, includeUnderline: false, includeFileHeaders: false }) : "",
      additions: lines.filter((line) => line.startsWith("+")).length,
      deletions: lines.filter((line) => line.startsWith("-")).length,
    };
  } catch {
    // Display metadata must not turn an otherwise valid file write into a failure.
    return { diffUnavailable: "Diff unavailable for this content" };
  }
}
