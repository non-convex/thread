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
  return `# Memory

Your memory has two scopes: project memory and cross-project global memory.

## Project memory

Project memory is stored automatically in this project's append-only Session Tree event log, session-tree/events.jsonl under Thread's per-project data directory. It preserves conversations, tool execution records, and compaction summaries across Sessions and branches. Compaction shortens the live context without deleting the original history; other Sessions and paths retained after rewind remain available.

Use session_search and session_read only when you determine that the user's current request depends on project history and the needed information or original evidence is missing from the current context. Do not retrieve history routinely or when the current context already answers the question. Search for relevant turns, then read only the turns needed to resolve the missing information. If a relevant turn id is already known, read it directly without searching again. Treat retrieved history as evidence of past work; inspect the current workspace when correctness depends on its present state.

## Global memory

Global memory is stored in one Markdown file shared across projects: ${filePath}. It is separate from the Session Tree and is not restored by project rewind.

When the user explicitly asks you to remember information that is unrelated to the current project and useful across projects, proactively persist it with read, edit, or write instead of only acknowledging the request. Merely stating a preference or giving a task instruction is not a request to remember it. Honor explicit requests to correct or forget existing global memories as well. Project-specific information belongs in project memory, where the conversation is already recorded automatically.

Before any change, read the current file from disk because it may be newer than the snapshot below. Create it with write if it does not exist. Keep at most 15 concise Markdown list entries in the exact form \`- [YYYY-MM-DD] memory content\`, with one independently useful fact or rule per entry. Use the current date for new or revised entries, and preserve the dates of unchanged entries. Merge duplicates, update superseded entries rather than appending contradictions, and preserve valuable unrelated entries. Remove obsolete or lower-value entries when needed to stay within the limit.

Do not store project-specific decisions, temporary task requirements, secrets, sensitive personal data, facts inferred from files or tool output, or your own unconfirmed guesses. Preserve the scope of what the user asked you to remember; do not turn a situational statement into a universal preference.

The snapshot below stays fixed for the current Session. /new reads the file for the new Session; switching Sessions restores their existing snapshots; restarting Thread refreshes all Session snapshots. Editing the file does not immediately replace the snapshot in this system prompt.

<global_memory_snapshot>
${body}
</global_memory_snapshot>`;
}
