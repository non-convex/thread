import type { Stats } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../utils/id.js";
import { WORKSPACE_STATE_FORMAT, type StagedWorkspaceState, type WorkspaceEntry, type WorkspaceState } from "./model.js";
import type { WorkspaceStateStore } from "./store.js";

const WALK_CONCURRENCY = 16;
const YIELD_INTERVAL_MS = 8;

function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

interface FileFingerprint {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
  mode: number;
  blobId: string;
}

class IoLimit {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

function sameFingerprint(cached: FileFingerprint, info: Stats, mode: number): boolean {
  if (cached.size !== info.size || cached.mtimeMs !== info.mtimeMs || cached.mode !== mode) return false;
  if (info.ino === 0 || cached.ino === 0) return true;
  return cached.ino === info.ino && cached.dev === info.dev;
}

export class WorkspaceSnapshotter {
  private readonly fingerprints = new Map<string, Map<string, FileFingerprint>>();
  private queue: Promise<void> = Promise.resolve();
  private lastPersist: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: WorkspaceStateStore) {}

  async capture(rootPath: string): Promise<WorkspaceState> {
    const staged = await this.captureStaged(rootPath);
    return staged.persisted;
  }

  captureStaged(rootPath: string): Promise<StagedWorkspaceState> {
    const staged = this.enqueue(async () => {
      await this.lastPersist.then(() => undefined, () => undefined);
      const captured = await this.captureStagedUnlocked(rootPath);
      this.lastPersist = captured.persisted;
      return captured;
    });
    return staged;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async captureStagedUnlocked(rootPath: string): Promise<StagedWorkspaceState> {
    await this.store.initialize();
    const entries: WorkspaceEntry[] = [];
    const nextFingerprints = new Map<string, FileFingerprint>();
    let blobWrites: Promise<void> = Promise.resolve();
    const scheduleBlob = (blobId: string, content: Buffer) => {
      blobWrites = blobWrites.then(() => this.store.storeBlob(blobId, content));
      void blobWrites.catch(() => undefined);
    };
    try {
      await this.walk(rootPath, entries, nextFingerprints, scheduleBlob);
    } catch (cause) {
      await blobWrites.catch(() => undefined);
      throw cause;
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const state: WorkspaceState = {
      format: WORKSPACE_STATE_FORMAT,
      formatVersion: 1,
      id: this.store.stateId(entries),
      projectId: this.store.project.id,
      capturedAt: Date.now(),
      policy: structuredClone(this.store.policy),
      entries,
    };
    const persisted = blobWrites.then(async () => {
      const stored = await this.store.persist(state);
      this.fingerprints.set(slash(rootPath), nextFingerprints);
      return stored;
    });
    void persisted.catch(() => undefined);
    return { state, persisted };
  }

  private async walk(
    rootPath: string,
    output: WorkspaceEntry[],
    nextFingerprints: Map<string, FileFingerprint>,
    scheduleBlob: (blobId: string, content: Buffer) => void,
  ): Promise<void> {
    const previous = this.fingerprints.get(slash(rootPath));
    const limit = new IoLimit(WALK_CONCURRENCY);
    let lastYield = Date.now();
    const maybeYield = async () => {
      const now = Date.now();
      if (now - lastYield < YIELD_INTERVAL_MS) return;
      lastYield = now;
      await new Promise<void>((resolve) => setImmediate(resolve));
    };

    const visit = async (directory: string): Promise<void> => {
      await maybeYield();
      const children = await limit.run(() => readdir(directory, { withFileTypes: true }));
      await Promise.all(children.map(async (child) => {
        await maybeYield();
        const absolute = path.join(directory, child.name);
        const relative = slash(path.relative(rootPath, absolute));
        if (this.excluded(relative)) return;
        const info = await limit.run(() => lstat(absolute));
        const mode = info.mode & 0o777;
        if (child.isSymbolicLink()) {
          output.push({ path: relative, kind: "symlink", mode, target: await limit.run(() => readlink(absolute)) });
          return;
        }
        if (child.isDirectory()) {
          output.push({ path: relative, kind: "directory", mode });
          await visit(absolute);
          return;
        }
        if (!child.isFile()) return;
        const cached = previous?.get(relative);
        if (cached && sameFingerprint(cached, info, mode)) {
          nextFingerprints.set(relative, cached);
          output.push({ path: relative, kind: "file", mode, size: cached.size, blobId: cached.blobId });
          return;
        }
        const content = await limit.run(() => readFile(absolute));
        const blobId = sha256(content);
        scheduleBlob(blobId, content);
        const fingerprint: FileFingerprint = {
          dev: info.dev,
          ino: info.ino,
          mtimeMs: info.mtimeMs,
          size: content.length,
          mode,
          blobId,
        };
        nextFingerprints.set(relative, fingerprint);
        output.push({ path: relative, kind: "file", mode, size: content.length, blobId });
      }));
    };

    await visit(rootPath);
  }

  private excluded(relativePath: string): boolean {
    return this.store.policy.excludedPaths.some((prefix) =>
      relativePath === prefix || relativePath.startsWith(`${prefix}/`)
    );
  }
}
