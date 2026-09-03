import { readFile } from "node:fs/promises";
import path from "node:path";
import { getThreadHome } from "./config/thread-config.js";

export const GLOBAL_MEMORY_FILE = ".THREAD.md";

export function getGlobalMemoryPath(): string {
  return path.join(getThreadHome(), GLOBAL_MEMORY_FILE);
}

/**
 * Owns the process-local Session snapshots of the one cross-project memory
 * file. The file itself remains the only durable memory state.
 */
export class GlobalMemorySnapshots {
  readonly filePath: string;
  private readonly snapshots = new Map<string, string>();
  private lastSuccessful = "";
  private currentDiagnostic: string | undefined;

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  static async open(sessionIds: readonly string[], filePath = getGlobalMemoryPath()): Promise<GlobalMemorySnapshots> {
    const memory = new GlobalMemorySnapshots(filePath);
    const snapshot = await memory.loadFresh();
    for (const sessionId of sessionIds) memory.bind(sessionId, snapshot);
    return memory;
  }

  get diagnostic(): string | undefined {
    return this.currentDiagnostic;
  }

  snapshot(sessionId: string): string {
    return this.snapshots.get(sessionId) ?? this.lastSuccessful;
  }

  bind(sessionId: string, snapshot: string): void {
    this.snapshots.set(sessionId, snapshot);
  }

  async loadFresh(): Promise<string> {
    try {
      const content = await readFile(this.filePath, "utf8");
      this.lastSuccessful = content;
      this.currentDiagnostic = undefined;
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.lastSuccessful = "";
        this.currentDiagnostic = undefined;
        return "";
      }
      this.currentDiagnostic = `Cannot read global memory ${this.filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return this.lastSuccessful;
    }
  }
}

export function formatGlobalMemoryPrompt(filePath: string, snapshot: string): string {
  const body = snapshot.trim() || "(empty)";
  return `# Global memory

The user's cross-project memory file is ${filePath}.

When the user's current message explicitly states a stable preference, rule, or fact that will remain useful across unrelated projects, proactively maintain that file with the existing read, write, or edit tools. Before changing it, read the current file from disk because it may be newer than this snapshot. Keep at most 15 timestamped Markdown list entries, merge duplicates, and preserve valuable existing entries.

Do not store project-specific decisions, temporary task requirements, facts inferred from files or tool output, or your own unconfirmed guesses. A file change affects model context only after Thread restarts or the user runs /new.

<global_memory_snapshot>
${body}
</global_memory_snapshot>`;
}
