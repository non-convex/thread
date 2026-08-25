import { constants } from "node:fs";
import { mkdir, open, readFile, rm, truncate, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { SessionLogEvent, SessionLogRecord } from "../domain.js";
import { stableId } from "../utils/id.js";
import { SessionCorruptionError, SessionProjection } from "./projection.js";

export interface SessionLogStoreOptions {
  rootPath: string;
  sidecarRoot: string;
  sessionId?: string;
}

export interface AppendOptions {
  flush?: boolean;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class SessionLogStore {
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly eventsPath: string;
  readonly cacheDir: string;
  readonly projection = new SessionProjection();
  private readonly lockPath: string;
  private logHandle: FileHandle | undefined;
  private lockHandle: FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();

  private constructor(options: SessionLogStoreOptions) {
    const resolvedRoot = path.resolve(options.rootPath);
    const normalizedRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
    this.sessionId = options.sessionId ?? stableId("session", normalizedRoot);
    if (!/^session_[A-Za-z0-9]+$/.test(this.sessionId)) {
      throw new Error(`Invalid session id: ${this.sessionId}`);
    }
    this.sessionDir = path.join(options.sidecarRoot, "sessions", this.sessionId);
    this.eventsPath = path.join(this.sessionDir, "events.jsonl");
    this.cacheDir = path.join(this.sessionDir, "cache");
    this.lockPath = path.join(options.sidecarRoot, "locks", `${this.sessionId}.lock`);
  }

  static async open(options: SessionLogStoreOptions): Promise<SessionLogStore> {
    const store = new SessionLogStore(options);
    await mkdir(store.sessionDir, { recursive: true });
    await mkdir(store.cacheDir, { recursive: true });
    await mkdir(path.dirname(store.lockPath), { recursive: true });
    await store.acquireLock();
    try {
      await store.load();
      store.logHandle = await open(store.eventsPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
      return store;
    } catch (error) {
      await store.close();
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
        if (Number.isFinite(pid) && isProcessAlive(pid)) {
          throw new Error(`Project Session is already open by process ${pid}`);
        }
        await rm(this.lockPath, { force: true });
      }
    }
    throw new Error(`Could not acquire Project Session lock: ${this.lockPath}`);
  }

  private async load(): Promise<void> {
    let content: Buffer;
    try {
      content = await readFile(this.eventsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (content.length === 0) return;
    if (content.at(-1) !== 0x0a) {
      const lastNewline = content.lastIndexOf(0x0a);
      const validLength = lastNewline < 0 ? 0 : lastNewline + 1;
      await truncate(this.eventsPath, validLength);
      content = content.subarray(0, validLength);
    }
    const lines = content.toString("utf8").split("\n");
    lines.pop();
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!line) throw new SessionCorruptionError(`Empty log record at line ${index + 1}`);
      let record: SessionLogRecord;
      try {
        record = JSON.parse(line) as SessionLogRecord;
      } catch (error) {
        throw new SessionCorruptionError(`Invalid JSON at line ${index + 1}: ${(error as Error).message}`);
      }
      this.projection.applyRecord(record);
    }
  }

  async append(
    factory: (seq: number, timestamp: number) => SessionLogEvent,
    options: AppendOptions = {},
  ): Promise<number> {
    return this.enqueue(async () => {
      const seq = this.projection.nextSequence;
      const timestamp = Date.now();
      const event = factory(seq, timestamp);
      const record = { seq, timestamp, ...event } as SessionLogRecord;
      await this.writeRecord(record, options.flush ?? false);
      return seq;
    });
  }

  async appendBatch(
    factory: (seq: number, timestamp: number) => SessionLogEvent[],
    options: AppendOptions = {},
  ): Promise<number> {
    return this.enqueue(async () => {
      const seq = this.projection.nextSequence;
      const timestamp = Date.now();
      const record: SessionLogRecord = { seq, timestamp, type: "batch", events: factory(seq, timestamp) };
      await this.writeRecord(record, options.flush ?? false);
      return seq;
    });
  }

  private async writeRecord(record: SessionLogRecord, flush: boolean): Promise<void> {
    if (!this.logHandle) throw new Error("Session log is closed");
    const line = `${JSON.stringify(record)}\n`;
    await this.logHandle.write(line, undefined, "utf8");
    if (flush) await this.logHandle.sync();
    this.projection.applyRecord(record);
    this.projection.touch(record.timestamp);
  }

  async flush(): Promise<void> {
    await this.logHandle?.sync();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async writeSessionManifest(rootPath: string): Promise<void> {
    const target = path.join(this.sessionDir, "session.json");
    await writeFile(
      target,
      `${JSON.stringify({
        id: this.sessionId,
        rootPath: path.resolve(rootPath),
        ...(this.projection.session ? { createdAt: this.projection.session.createdAt } : {}),
      }, null, 2)}\n`,
      "utf8",
    );
  }

  async close(): Promise<void> {
    await this.queue;
    await this.logHandle?.sync().catch(() => undefined);
    await this.logHandle?.close().catch(() => undefined);
    this.logHandle = undefined;
    await this.lockHandle?.close().catch(() => undefined);
    this.lockHandle = undefined;
    await rm(this.lockPath, { force: true }).catch(() => undefined);
  }
}
