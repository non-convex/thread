import { chmod, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Project } from "../project/model.js";
import type { FileEditEntry, Turn } from "../session-tree/model.js";
import type { SessionTreeService } from "../session-tree/service.js";
import { isPathInside, realPath, resolveWorkspacePath } from "../tools/path-safety.js";
import { FileHistoryStore } from "./store.js";

export interface FileContents {
  content: Buffer;
  mode: number;
}

export type SaveBeforeWrite = (before: FileContents | undefined) => Promise<void>;

export interface FileEditTracker {
  track<T>(target: string, operation: (save: SaveBeforeWrite) => Promise<T>): Promise<T>;
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export class FileHistoryService {
  readonly store: FileHistoryStore;
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly project: Project,
    private readonly tree: SessionTreeService,
    private readonly excludedPaths: readonly string[] = [],
  ) {
    this.store = new FileHistoryStore(project);
  }

  forTurn(turnId: string): FileEditTracker {
    return { track: (target, operation) => this.track(turnId, target, operation) };
  }

  private async track<T>(turnId: string, target: string, operation: (save: SaveBeforeWrite) => Promise<T>): Promise<T> {
    const key = pathKey(target);
    const previous = this.pending.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
      if (this.tree.projection.turns.get(turnId)?.status !== "running") throw new Error(`Cannot edit files for inactive turn ${turnId}`);
      return operation(async (before) => {
        const root = await realPath(this.project.rootPath);
        if (!isPathInside(root, target) || await this.isExcluded(target)) return;
        const relative = path.relative(root, target).replaceAll("\\", "/");
        const existing = (this.tree.projection.entriesByTurn.get(turnId) ?? []).some((entry) =>
          entry.type === "file_edit" && pathKey(entry.path) === pathKey(relative));
        if (existing) return;
        const saved = before ? { blobId: await this.store.put(before.content), mode: before.mode } : null;
        await this.tree.appendFileEdit({ turnId, path: relative, before: saved });
      });
    });
    this.pending.set(key, current);
    try {
      return await current;
    } finally {
      if (this.pending.get(key) === current) this.pending.delete(key);
    }
  }

  private async isExcluded(target: string): Promise<boolean> {
    for (const excluded of [this.project.statePath, ...this.excludedPaths]) {
      if (isPathInside(await realPath(excluded), target)) return true;
    }
    return false;
  }

  private records(turns: readonly Turn[]): FileEditEntry[] {
    return turns.flatMap((turn) => (this.tree.projection.entriesByTurn.get(turn.id) ?? [])
      .filter((entry): entry is FileEditEntry => entry.type === "file_edit"));
  }

  async restore(turns: readonly Turn[]): Promise<void> {
    const selected = new Map<string, FileEditEntry>();
    for (const entry of this.records(turns)) {
      const key = pathKey(entry.path);
      if (!selected.has(key)) selected.set(key, entry);
    }
    // Validate all sources and destinations before changing the first file.
    for (const entry of selected.values()) {
      await this.restorePath(entry.path);
      if (entry.before) await this.store.read(entry.before.blobId);
    }
    for (const entry of selected.values()) {
      const target = await this.restorePath(entry.path);
      if (!entry.before) {
        await rm(target, { force: true });
      } else {
        const content = await this.store.read(entry.before.blobId);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
        await chmod(target, entry.before.mode);
      }
    }
  }

  private async restorePath(relative: string): Promise<string> {
    const target = await resolveWorkspacePath(this.project.rootPath, relative, { forWrite: true });
    if (await this.isExcluded(target)) {
      throw new Error(`File history cannot restore Thread state: ${relative}`);
    }
    try {
      if (!(await lstat(target)).isFile()) throw new Error(`File history target is not a regular file: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return target;
  }

  async verify(turnId: string): Promise<void> {
    for (const entry of this.tree.projection.entriesByTurn.get(turnId) ?? []) {
      if (entry.type === "file_edit" && entry.before) await this.store.read(entry.before.blobId);
    }
  }

  async garbageCollect(): Promise<{ blobsRemoved: number }> {
    await this.settle();
    const referenced = new Set(this.records([...this.tree.projection.turns.values()])
      .flatMap((entry) => entry.before ? [entry.before.blobId] : []));
    return this.store.garbageCollect(referenced);
  }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.pending.values()]);
  }
}
