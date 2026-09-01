import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../utils/id.js";

export const COMPACTION_CACHE_FORMAT = "thread-context-compaction-v1" as const;

export interface CompactionCacheEntry {
  format: typeof COMPACTION_CACHE_FORMAT;
  formatVersion: 1;
  sessionId: string;
  throughTurnId: string;
  pathFingerprint: string;
  summary: string;
  createdAt: number;
}

export function pathFingerprint(turnIds: readonly string[]): string {
  return sha256(JSON.stringify(turnIds));
}

export class ContextCache {
  constructor(private readonly rootPath: string) {}

  private target(sessionId: string): string {
    if (!/^session_[A-Za-z0-9]+$/.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
    return path.join(this.rootPath, "compaction", `${sessionId}.json`);
  }

  async read(sessionId: string): Promise<CompactionCacheEntry | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.target(sessionId), "utf8")) as Partial<CompactionCacheEntry>;
      if (parsed.format !== COMPACTION_CACHE_FORMAT || parsed.formatVersion !== 1 || parsed.sessionId !== sessionId ||
          typeof parsed.throughTurnId !== "string" || typeof parsed.pathFingerprint !== "string" ||
          typeof parsed.summary !== "string" || typeof parsed.createdAt !== "number") {
        await this.invalidate(sessionId);
        return undefined;
      }
      return parsed as CompactionCacheEntry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) {
        await this.invalidate(sessionId);
        return undefined;
      }
      throw error;
    }
  }

  async write(entry: CompactionCacheEntry): Promise<void> {
    const target = this.target(entry.sessionId);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}`;
    try {
      await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async invalidate(sessionId: string): Promise<void> {
    await rm(this.target(sessionId), { force: true });
  }
}
