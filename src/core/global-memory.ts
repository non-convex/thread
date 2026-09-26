import type { Message } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getThreadHome } from "./config/home.js";
import type { FileContents } from "./file-history/service.js";
import { canonicalTarget, resolveWorkspacePath, samePath } from "./tools/path-safety.js";
import type { ToolContext } from "./tools/types.js";
import { atomicFile } from "./utils/atomic-file.js";

export const GLOBAL_MEMORY_FILE = ".THREAD.md";

export function getGlobalMemoryPath(): string {
  return path.join(getThreadHome(), GLOBAL_MEMORY_FILE);
}

export type GlobalMemoryCommit = (before: FileContents | undefined, content: Buffer, beforeCommit: () => Promise<void>) => Promise<void>;
type MemoryInvocation = Pick<ToolContext, "rootPath" | "signal" | "invocation">;

// Shared by runtimes in this process; entries disappear when their I/O settles.
const pendingMemoryAccess = new Map<string, Promise<unknown>>();

function revisionStat(info: BigIntStats): string {
  return [info.dev, info.ino, info.mode, info.size, info.birthtimeNs, info.mtimeNs, info.ctimeNs]
    .map(String).join(":");
}

/** Observe both the contents and the identity of a stable publication, not only its text. */
async function observeGlobalMemoryRevision(filePath: string, signal?: AbortSignal, expectedContent?: Buffer): Promise<string> {
  const inspect = async (): Promise<BigIntStats | undefined> => stat(filePath, { bigint: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const before = await inspect();
    signal?.throwIfAborted();
    if (!before) {
      if (!(await inspect())) {
        signal?.throwIfAborted();
        if (expectedContent !== undefined) throw new Error("Global memory changed after Dreamer's write; cannot confirm its published revision.");
        return "missing";
      }
      continue;
    }
    let content: Buffer;
    try { content = await readFile(filePath, { signal }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    signal?.throwIfAborted();
    const after = await inspect();
    signal?.throwIfAborted();
    if (!after || revisionStat(before) !== revisionStat(after)) continue;
    if (expectedContent !== undefined && !content.equals(expectedContent)) {
      throw new Error("Global memory changed after Dreamer's write; cannot confirm its published revision.");
    }
    return createHash("sha256").update(revisionStat(after)).update("\0").update(content).digest("hex");
  }
  signal?.throwIfAborted();
  throw new Error("Global memory changed while determining its revision. Retry when it settles.");
}

export async function globalMemoryRevision(filePath: string, signal?: AbortSignal): Promise<string> {
  return observeGlobalMemoryRevision(filePath, signal);
}

function validateGlobalMemoryEntries(content: Buffer): void {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
  let count = 0;
  for (const line of text.split(/\r\n|\r|\n/u)) {
    if (!line.trim()) continue;
    const entry = /^- \[(\d{4})-(\d{2})-(\d{2})\] (.+)$/u.exec(line);
    if (!entry || !entry[4]!.trim()) throw new Error("Global memory must contain only dated Markdown list entries (- [YYYY-MM-DD] content).");
    const year = Number(entry[1]);
    const month = Number(entry[2]);
    const day = Number(entry[3]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) {
      throw new Error("Global memory entry has an invalid date.");
    }
    if (++count > 15) throw new Error("Global memory must contain no more than 15 entries.");
  }
  if (content.length > 0 && count === 0) throw new Error("Global memory must be empty or contain dated Markdown list entries.");
}

/** One execution's observed memory version, separate from its fixed Session snapshot. */
export class GlobalMemoryAccess {
  private observed: { content: Buffer | null; toolCallId: string; visible: boolean } | undefined;
  private expectedRevision: string | undefined;

  constructor(private readonly filePath: string, private readonly memoryOnly = false,
    private readonly options: { expectedRevision?: string; validateEntries?: boolean } = {}) {
    this.expectedRevision = options.expectedRevision;
  }

  get revision(): string | undefined { return this.expectedRevision; }

  get readObservation(): { toolCallId: string; missing: boolean; visible: boolean } | undefined {
    const observed = this.observed;
    return observed ? { toolCallId: observed.toolCallId, missing: observed.content === null, visible: observed.visible } : undefined;
  }

  observeModelContext(messages: readonly Message[]): void {
    const observed = this.observed;
    if (observed) observed.visible = messages.some((message) =>
      message.role === "toolResult" && message.toolCallId === observed.toolCallId);
  }

  private async memoryTarget(target: string, rootPath: string): Promise<string | undefined> {
    const configured = path.resolve(this.filePath);
    // Dreamer applies the write path's symlink checks even to reads.
    const memory = this.memoryOnly
      ? await resolveWorkspacePath(rootPath, configured, { forWrite: true, allowedOutsidePaths: [configured] })
      : await canonicalTarget(configured).catch((error) => {
        // A broken memory configuration must not block Main's unrelated file tools.
        if (samePath(configured, target)) throw error;
        return configured;
      });
    if (samePath(memory, await canonicalTarget(target))) return memory;
    if (this.memoryOnly) throw new Error(`Dreamer may access only the global memory file: ${configured}`);
    return undefined;
  }

  private async exclusive<T>(target: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const key = process.platform === "win32" ? target.toLowerCase() : target;
    const previous = pendingMemoryAccess.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => { signal.throwIfAborted(); return operation(); });
    pendingMemoryAccess.set(key, current);
    try { return await current; }
    finally { if (pendingMemoryAccess.get(key) === current) pendingMemoryAccess.delete(key); }
  }

  async read<T>(target: string, context: MemoryInvocation, operation: () => Promise<T>): Promise<T> {
    const memory = await this.memoryTarget(target, context.rootPath);
    if (!memory) return operation();
    return this.exclusive(memory, context.signal, async () => {
      const current = await this.memoryTarget(target, context.rootPath);
      if (!current || !samePath(current, memory)) throw new Error("Global memory target changed while waiting to read.");
      this.observed = undefined;
      const content = await readFile(memory, { signal: context.signal }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      const observed = { content, toolCallId: context.invocation.toolCallId, visible: false };
      try {
        const result = await operation();
        this.observed = observed;
        return result;
      } catch (error) {
        // Reading a missing file authorizes a subsequent create, not a blind overwrite.
        if (content === null && (error as NodeJS.ErrnoException).code === "ENOENT") this.observed = observed;
        throw error;
      }
    });
  }

  async write<T>(target: string, context: MemoryInvocation, operation: (commit?: GlobalMemoryCommit) => Promise<T>): Promise<T> {
    const memory = await this.memoryTarget(target, context.rootPath);
    if (!memory) return operation();
    return this.exclusive(memory, context.signal, () => operation(async (before, content, beforeCommit) => {
      const observed = this.observed;
      // Eager reads in this response (or a discarded retry) have not informed the model yet.
      if (!observed?.visible) {
        throw new Error("Read global memory in an earlier model step before changing it.");
      }
      if (observed.content === null ? before !== undefined : !before?.content.equals(observed.content)) {
        this.observed = undefined;
        throw new Error("Global memory changed since it was read. Re-read it in a separate step and regenerate the update.");
      }
      if (this.options.validateEntries) validateGlobalMemoryEntries(content);
      const guardedCommit = async () => {
        await beforeCommit();
        if (this.expectedRevision !== undefined &&
            await globalMemoryRevision(memory, context.signal) !== this.expectedRevision) {
          throw new Error("Global memory changed since Dreamer's source revision. Re-review the material against current memory before writing; re-reading alone cannot authorize this update.");
        }
      };
      await atomicFile(memory, content, { ...(before ? { mode: before.mode } : {}), overwrite: before !== undefined,
        signal: context.signal, beforeCommit: guardedCommit });
      // Publication already completed. Settle this short observation even if the turn was cancelled;
      // never advance to an external writer's different content sampled after our publication.
      if (this.expectedRevision !== undefined) this.expectedRevision = await observeGlobalMemoryRevision(memory, undefined, content);
      this.observed = { ...observed, content: Buffer.from(content) };
    }));
  }
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

Before any change, read the current file from disk in a separate model step because it may be newer than the snapshot below. Create it with write if that read reports it does not exist. If a write or edit reports that global memory changed, read it again and regenerate the update from the new contents; do not retry stale edits. Keep at most 15 concise Markdown list entries in the exact form \`- [YYYY-MM-DD] memory content\`, with one independently useful fact or rule per entry. Use the current date for new or revised entries, and preserve the dates of unchanged entries. Merge duplicates, update superseded entries rather than appending contradictions, and preserve valuable unrelated entries. Remove obsolete or lower-value entries when needed to stay within the limit.

Do not store project-specific decisions, temporary task requirements, secrets, sensitive personal data, facts inferred from files or tool output, or your own unconfirmed guesses. Preserve the scope of what the user asked you to remember; do not turn a situational statement into a universal preference.

The snapshot below stays fixed for the current Session. /new reads the file for the new Session; switching Sessions restores their existing snapshots; restarting Thread refreshes all Session snapshots. Editing the file does not immediately replace the snapshot in this system prompt.

<global_memory_snapshot>
${body}
</global_memory_snapshot>`;
}
