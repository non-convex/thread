import { mkdir, open, readFile, truncate, type FileHandle } from "node:fs/promises";
import path from "node:path";

/** Recover an interrupted final write; complete records are never discarded. */
export async function readLogLines(file: string): Promise<string[]> {
  let content: Buffer;
  try { content = await readFile(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (content.length && content.at(-1) !== 0x0a) {
    const length = content.lastIndexOf(0x0a) + 1;
    await truncate(file, length);
    content = content.subarray(0, length);
  }
  return content.length ? content.toString("utf8").slice(0, -1).split("\n") : [];
}

/** Ordered writes, durability barriers and shutdown shared by both project logs. */
export class EventLog<R> {
  private handle: FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;
  private readonly pending = new Set<Promise<R>>();

  constructor(readonly file: string, private readonly apply: (record: R) => void) {}

  async open(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    this.handle = await open(this.file, "a", 0o600);
  }

  async append(create: () => R, flush: boolean): Promise<R> {
    this.assertWritable();
    const accepted = this.appendAccepted(create, flush);
    this.pending.add(accepted);
    try { return await accepted; } finally { this.pending.delete(accepted); }
  }

  private async appendAccepted(create: () => R, flush: boolean): Promise<R> {
    if (flush) await this.queue;
    const record = create();
    this.apply(record);
    const persisted = this.enqueue(async () => {
      if (!this.handle) throw new Error(`Event log is closed: ${this.file}`);
      await this.handle.write(`${JSON.stringify(record)}\n`, undefined, "utf8");
      if (flush) await this.handle.sync();
    });
    if (flush) await persisted;
    return record;
  }

  write(operation: () => Promise<void>): Promise<void> {
    this.assertWritable();
    return this.enqueue(operation);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const pending = this.queue.then(operation);
    this.queue = pending.catch((cause) => {
      this.failure ??= cause instanceof Error ? cause : new Error(String(cause));
      throw this.failure;
    });
    // Background writes remain observable at the next durability barrier.
    void this.queue.catch(() => undefined);
    return pending;
  }

  close(): Promise<void> {
    return this.closing ??= Promise.resolve().then(async () => {
      try {
        // Accepted durable appends may still be waiting to enqueue their records.
        await Promise.allSettled(this.pending);
        await this.queue;
        await this.handle?.sync();
      } finally {
        await this.handle?.close().catch(() => undefined);
        this.handle = undefined;
      }
    });
  }

  private assertWritable(): void {
    if (this.closing) throw new Error(`Event log is closed: ${this.file}`);
    if (this.failure !== undefined) throw new Error(`Event log persistence failed: ${this.file}`, { cause: this.failure });
  }
}
