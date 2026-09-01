import { constants } from "node:fs";
import { mkdir, open, readFile, rm, truncate, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Project } from "../project/model.js";
import type { SessionTreeEvent, SessionTreeRecord } from "./model.js";
import { SESSION_TREE_FORMAT } from "./model.js";
import { SessionTreeCorruptionError, SessionTreeProjection } from "./projection.js";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class SessionTreeRepository {
  readonly projection = new SessionTreeProjection();
  readonly treePath: string;
  readonly eventsPath: string;
  readonly cachePath: string;
  private readonly lockPath: string;
  private eventsHandle: FileHandle | undefined;
  private lockHandle: FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();
  private writeFailure: Error | undefined;

  private constructor(readonly project: Project) {
    this.treePath = path.join(project.statePath, "session-tree");
    this.eventsPath = path.join(this.treePath, "events.jsonl");
    this.cachePath = path.join(this.treePath, "cache");
    this.lockPath = path.join(project.statePath, "session-tree.lock");
  }

  static async open(project: Project): Promise<SessionTreeRepository> {
    const repository = new SessionTreeRepository(project);
    await mkdir(repository.treePath, { recursive: true });
    await mkdir(repository.cachePath, { recursive: true });
    await repository.acquireLock();
    try {
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
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.lockHandle = await open(this.lockPath, "wx", 0o600);
        await this.lockHandle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
        await this.lockHandle.sync();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const content = await readFile(this.lockPath, "utf8").catch(() => "");
        const pid = Number.parseInt(content.split(/\r?\n/, 1)[0] ?? "", 10);
        if (Number.isFinite(pid) && processAlive(pid)) {
          throw new Error(`Session Tree is already open by process ${pid}`);
        }
        await rm(this.lockPath, { force: true });
      }
    }
    throw new Error(`Could not acquire Session Tree lock: ${this.lockPath}`);
  }

  private async load(): Promise<void> {
    const manifestPath = path.join(this.treePath, "tree.json");
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
      const value = manifest as { format?: unknown; formatVersion?: unknown };
      if (value.format !== SESSION_TREE_FORMAT || value.formatVersion !== 1) {
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
    persistAfter?: Promise<unknown>,
  ): Promise<number> {
    this.assertWritable();
    if (flush) {
      await this.queue;
      this.assertWritable();
    }
    const sequence = this.projection.nextSequence;
    const timestamp = Date.now();
    const record = { sequence, timestamp, ...factory(sequence, timestamp) } as SessionTreeRecord;
    this.projection.applyRecord(record);
    const persisted = this.enqueueWrite(record, flush, persistAfter);
    if (flush) await persisted;
    return sequence;
  }

  async appendBatch(
    factory: (sequence: number, timestamp: number) => SessionTreeEvent[],
    flush = false,
    persistAfter?: Promise<unknown>,
  ): Promise<number> {
    this.assertWritable();
    if (flush) {
      await this.queue;
      this.assertWritable();
    }
    const sequence = this.projection.nextSequence;
    const timestamp = Date.now();
    const record: SessionTreeRecord = { sequence, timestamp, type: "batch", events: factory(sequence, timestamp) };
    this.projection.applyRecord(record);
    const persisted = this.enqueueWrite(record, flush, persistAfter);
    if (flush) await persisted;
    return sequence;
  }

  private async write(record: SessionTreeRecord, flush: boolean): Promise<void> {
    if (!this.eventsHandle) throw new Error("Session Tree repository is closed");
    await this.eventsHandle.write(`${JSON.stringify(record)}\n`, undefined, "utf8");
    if (flush) await this.eventsHandle.sync();
  }

  private enqueueWrite(record: SessionTreeRecord, flush: boolean, persistAfter?: Promise<unknown>): Promise<void> {
    const persisted = this.queue.then(async () => {
      await persistAfter;
      await this.write(record, flush);
    });
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
    if (this.writeFailure) throw new Error("Session Tree persistence failed", { cause: this.writeFailure });
  }

  async writeManifest(): Promise<void> {
    const tree = this.projection.tree;
    if (!tree) throw new Error("Cannot write a manifest before creating the Session Tree");
    await writeFile(path.join(this.treePath, "tree.json"), `${JSON.stringify(tree, null, 2)}\n`, "utf8");
  }

  async flush(): Promise<void> {
    await this.queue;
    this.assertWritable();
    await this.eventsHandle?.sync();
  }

  async close(): Promise<void> {
    let failure: Error | undefined;
    try {
      await this.queue;
      await this.eventsHandle?.sync();
    } catch (cause) {
      failure = cause instanceof Error ? cause : new Error(String(cause));
    } finally {
      await this.eventsHandle?.close().catch(() => undefined);
      this.eventsHandle = undefined;
      await this.lockHandle?.close().catch(() => undefined);
      this.lockHandle = undefined;
      await rm(this.lockPath, { force: true }).catch(() => undefined);
    }
    if (failure) throw failure;
  }
}
