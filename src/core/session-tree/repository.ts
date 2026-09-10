import { constants } from "node:fs";
import { mkdir, open, readFile, truncate, writeFile, type FileHandle } from "node:fs/promises";
import { tryLock } from "fs-native-extensions";
import path from "node:path";
import type { Project } from "../project/model.js";
import type { SessionTreeEvent, SessionTreeRecord } from "./model.js";
import { SESSION_TREE_FORMAT } from "./model.js";
import { SessionTreeCorruptionError, SessionTreeProjection } from "./projection.js";

export class SessionTreeRepository {
  readonly projection = new SessionTreeProjection();
  readonly treePath: string;
  readonly eventsPath: string;
  private readonly lockPath: string;
  private eventsHandle: FileHandle | undefined;
  private lockHandle: FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();
  private writeFailure: Error | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly pendingAppends = new Set<Promise<number>>();

  private constructor(readonly project: Project) {
    this.treePath = path.join(project.statePath, "session-tree");
    this.eventsPath = path.join(this.treePath, "events.jsonl");
    this.lockPath = path.join(project.statePath, "session-tree.lock");
  }

  static async open(project: Project): Promise<SessionTreeRepository> {
    const repository = new SessionTreeRepository(project);
    await mkdir(repository.treePath, { recursive: true });
    try {
      await repository.acquireLock();
      await repository.load();
      repository.eventsHandle = await open(
        repository.eventsPath,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY,
        0o600,
      );
      return repository;
    } catch (error) {
      await repository.close();
      throw error;
    }
  }

  private async acquireLock(): Promise<void> {
    this.lockHandle = await open(this.lockPath, "a+", 0o600);
    if (!tryLock(this.lockHandle.fd)) {
      throw new Error(`Session Tree is already open: ${this.lockPath}`);
    }
  }

  private async load(): Promise<void> {
    const manifestPath = path.join(this.treePath, "tree.json");
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
      const value = manifest as { format?: unknown; formatVersion?: unknown };
      if (value.format !== SESSION_TREE_FORMAT || value.formatVersion !== 2) {
        throw new Error(`Unsupported Session Tree manifest at ${manifestPath}; old data is not loaded`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      manifest = undefined;
    }
    let content: Buffer;
    try {
      content = await readFile(this.eventsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (manifest) throw new Error(`Session Tree manifest exists but its event log is missing: ${this.eventsPath}`);
        return;
      }
      throw error;
    }
    if (content.length === 0) {
      if (manifest) throw new Error(`Session Tree manifest exists but its event log is empty: ${this.eventsPath}`);
      return;
    }
    if (content.at(-1) !== 0x0a) {
      const newline = content.lastIndexOf(0x0a);
      const validLength = newline < 0 ? 0 : newline + 1;
      await truncate(this.eventsPath, validLength);
      content = content.subarray(0, validLength);
    }
    const lines = content.toString("utf8").split("\n");
    lines.pop();
    for (let index = 0; index < lines.length; index++) {
      try {
        this.projection.applyRecord(JSON.parse(lines[index]!) as SessionTreeRecord);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new SessionTreeCorruptionError(`Invalid JSON at line ${index + 1}: ${error.message}`);
        }
        throw error;
      }
    }
    if (this.projection.tree?.format !== SESSION_TREE_FORMAT) {
      throw new Error("This project contains unsupported or old Thread data; migration and compatibility are disabled");
    }
    if (manifest) {
      const value = manifest as { id?: unknown; projectId?: unknown };
      if (value.id !== this.projection.tree.id || value.projectId !== this.projection.tree.projectId) {
        throw new Error(`Session Tree manifest does not match its event log: ${manifestPath}`);
      }
    }
  }

  async append(
    factory: (sequence: number, timestamp: number) => SessionTreeEvent,
    flush = false,
  ): Promise<number> {
    return this.appendRecord((sequence, timestamp) => (
      { sequence, timestamp, ...factory(sequence, timestamp) }
    ), flush);
  }

  async appendBatch(
    factory: (sequence: number, timestamp: number) => SessionTreeEvent[],
    flush = false,
  ): Promise<number> {
    return this.appendRecord((sequence, timestamp) => (
      { sequence, timestamp, type: "batch", events: factory(sequence, timestamp) }
    ), flush);
  }

  private async appendRecord(
    factory: (sequence: number, timestamp: number) => SessionTreeRecord,
    flush: boolean,
  ): Promise<number> {
    this.assertWritable();
    const pending = this.appendAcceptedRecord(factory, flush);
    this.pendingAppends.add(pending);
    try {
      return await pending;
    } finally {
      this.pendingAppends.delete(pending);
    }
  }

  private async appendAcceptedRecord(
    factory: (sequence: number, timestamp: number) => SessionTreeRecord,
    flush: boolean,
  ): Promise<number> {
    if (flush) {
      await this.queue;
      this.assertPersistenceHealthy();
    }
    const sequence = this.projection.nextSequence;
    const timestamp = Date.now();
    const record = factory(sequence, timestamp);
    this.projection.applyRecord(record);
    const persisted = this.enqueueWrite(() => this.write(record, flush));
    if (flush) await persisted;
    return sequence;
  }

  private async write(record: SessionTreeRecord, flush: boolean): Promise<void> {
    if (!this.eventsHandle) throw new Error("Session Tree repository is closed");
    await this.eventsHandle.write(`${JSON.stringify(record)}\n`, undefined, "utf8");
    if (flush) await this.eventsHandle.sync();
  }

  private enqueueWrite(write: () => Promise<void>): Promise<void> {
    const persisted = this.queue.then(write);
    this.queue = persisted.catch((cause) => {
      this.writeFailure ??= cause instanceof Error ? cause : new Error(String(cause));
      throw this.writeFailure;
    });
    // Background appends intentionally do not await this promise. Keep their
    // rejection observed; the next durability barrier still receives it.
    void this.queue.catch(() => undefined);
    return persisted;
  }

  private assertWritable(): void {
    if (this.closePromise) throw new Error("Session Tree repository is closed");
    this.assertPersistenceHealthy();
  }

  private assertPersistenceHealthy(): void {
    if (this.writeFailure) throw new Error("Session Tree persistence failed", { cause: this.writeFailure });
  }

  async writeManifest(): Promise<void> {
    this.assertWritable();
    const tree = this.projection.tree;
    if (!tree) throw new Error("Cannot write a manifest before creating the Session Tree");
    const content = `${JSON.stringify(tree, null, 2)}\n`;
    await this.enqueueWrite(() => writeFile(path.join(this.treePath, "tree.json"), content, "utf8"));
  }

  async flush(): Promise<void> {
    this.assertWritable();
    await this.enqueueWrite(async () => { await this.eventsHandle?.sync(); });
  }

  close(): Promise<void> {
    return this.closePromise ??= this.closeResources();
  }

  private async closeResources(): Promise<void> {
    let failure: Error | undefined;
    try {
      // Durable appends admitted before close may still be waiting for an
      // earlier write before they can enqueue their own record.
      await Promise.allSettled(this.pendingAppends);
      await this.queue;
      await this.eventsHandle?.sync();
    } catch (cause) {
      failure = cause instanceof Error ? cause : new Error(String(cause));
    } finally {
      await this.eventsHandle?.close().catch(() => undefined);
      this.eventsHandle = undefined;
      if (this.lockHandle) {
        // Keep the lock file's identity stable. Unlinking it lets another opener
        // lock a replacement while an existing handle still owns the old file.
        await this.lockHandle.close().catch((cause) => { failure ??= cause; });
        this.lockHandle = undefined;
      }
    }
    if (failure) throw failure;
  }
}
