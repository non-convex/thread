import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import type { Project } from "../project/model.js";
import type { FileEditEntry, Turn } from "../session-tree/model.js";
import type { SessionTreeService } from "../session-tree/service.js";
import { isPathInside, realPath, resolveWorkspacePath } from "../tools/path-safety.js";
import { FileHistoryStore } from "./store.js";
import { atomicFile, syncDirectory } from "../utils/atomic-file.js";

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
    readonly captureEnabled = true,
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
        // Tracking still serializes edits from the main agent and its workers.
        // Disabling checkpoints only removes before-image capture and journaling.
        if (!this.captureEnabled) return;
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
      // A configured memory or state file may not exist until the first write.
      // Resolve its nearest existing ancestor without creating it as a side effect.
      let ancestor = path.resolve(excluded);
      let suffix = "";
      for (;;) {
        try {
          if (isPathInside(path.join(await realPath(ancestor), suffix), target)) return true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          const parent = path.dirname(ancestor);
          if (parent === ancestor) throw error;
          suffix = path.join(path.basename(ancestor), suffix);
          ancestor = parent;
        }
      }
    }
    return false;
  }

  private records(turns: readonly Turn[]): FileEditEntry[] {
    return turns.flatMap((turn) => (this.tree.projection.entriesByTurn.get(turn.id) ?? [])
      .filter((entry): entry is FileEditEntry => entry.type === "file_edit"));
  }

  async rewind(turns: readonly Turn[]): Promise<void> {
    this.tree.requireIdle();
    if (!this.captureEnabled) throw new Error("File checkpoints are disabled for this runtime");
    const first = turns[0];
    const last = turns.at(-1);
    if (!first || !last) throw new Error("File rewind requires at least one turn");
    // Invalid backups or paths must fail before an intent is committed.
    await this.prepareRestore(turns);
    await this.tree.beginFileRewind({ sessionId: first.sessionId, fromTurnId: last.id, toTurnId: first.parentTurnId });
    await this.resumePendingRewind();
  }

  /** Replaying the original before-images is idempotent, including deletions. */
  async resumePendingRewind(): Promise<void> {
    const rewind = this.tree.projection.pendingFileRewind;
    if (!rewind) return;
    try {
      const sourcePath = this.tree.pathToTurn(rewind.fromTurnId);
      const start = rewind.toTurnId === null ? 0 : sourcePath.findIndex((turn) => turn.id === rewind.toTurnId) + 1;
      if (rewind.toTurnId !== null && start === 0) throw new Error("File rewind target is not an ancestor of its source");
      const selected = await this.prepareRestore(sourcePath.slice(start));
      for (const entry of selected) {
        const target = await this.restorePath(entry.path);
        if (!entry.before) {
          // Absence is already the desired state; its parent may be absent too.
          const exists = await lstat(target).then(() => true, (error) => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            return false;
          });
          if (exists) {
            await rm(target);
            await syncDirectory(path.dirname(target));
          }
        } else {
          const content = await this.store.read(entry.before.blobId);
          await atomicFile(target, content, {
            mode: entry.before.mode,
            beforeCommit: async () => {
              if (pathKey(await this.restorePath(entry.path)) !== pathKey(target)) {
                throw new Error(`File history target changed while restoring: ${entry.path}`);
              }
            },
          });
        }
      }
      await this.tree.finishFileRewind();
    } catch (cause) {
      throw new Error(`File rewind is unfinished: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        "Some files may already be restored. Resolve the file error and reopen the project; recovery will restore all recorded paths again before accepting new work.", { cause });
    }
  }

  private async prepareRestore(turns: readonly Turn[]): Promise<FileEditEntry[]> {
    const untracked = turns.find((turn) => !turn.fileCheckpoints);
    if (untracked) throw new Error(`Cannot restore files across turn ${untracked.id}: file checkpoints were disabled`);
    const selected = new Map<string, FileEditEntry>();
    for (const entry of this.records(turns)) {
      const key = pathKey(entry.path);
      if (!selected.has(key)) selected.set(key, entry);
    }
    for (const entry of selected.values()) {
      await this.restorePath(entry.path);
      if (entry.before) await this.store.read(entry.before.blobId);
    }
    return [...selected.values()];
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
