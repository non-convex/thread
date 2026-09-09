import { constants } from "node:fs";
import { mkdir, open, readFile, truncate, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Project } from "../project/model.js";
import { AGENT_TASK_FORMAT, type AgentTaskEvent, type AgentTaskRecord } from "./model.js";
import { AgentTaskProjection } from "./projection.js";

export class AgentTaskRepository {
  readonly projection = new AgentTaskProjection();
  readonly rootPath: string;
  readonly eventsPath: string;
  private handle: FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();
  private writeFailure: Error | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly pendingAppends = new Set<Promise<void>>();

  private constructor(readonly project: Project) {
    this.rootPath = path.join(project.statePath, "agent-tasks");
    this.eventsPath = path.join(this.rootPath, "events.jsonl");
  }

  static async open(project: Project): Promise<AgentTaskRepository> {
    const repository = new AgentTaskRepository(project);
    await mkdir(repository.rootPath, { recursive: true });
    await repository.load();
    repository.handle = await open(repository.eventsPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
    return repository;
  }

  async append(event: AgentTaskEvent, flush = false): Promise<void> {
    this.assertWritable();
    const pending = this.appendAccepted(event, flush);
    this.pendingAppends.add(pending);
    try {
      await pending;
    } finally {
      this.pendingAppends.delete(pending);
    }
  }

  private async appendAccepted(event: AgentTaskEvent, flush: boolean): Promise<void> {
    if (flush) await this.queue;
    const record: AgentTaskRecord = {
      format: AGENT_TASK_FORMAT,
      formatVersion: 2,
      sequence: this.projection.nextSequence,
      timestamp: Date.now(),
      ...structuredClone(event),
    };
    this.projection.apply(record);
    const persisted = this.enqueueWrite(async () => {
      if (!this.handle) throw new Error("Agent Task repository is closed");
      await this.handle.write(`${JSON.stringify(record)}\n`, undefined, "utf8");
      if (flush) await this.handle.sync();
    });
    if (flush) await persisted;
  }

  private enqueueWrite(write: () => Promise<void>): Promise<void> {
    const persisted = this.queue.then(write);
    this.queue = persisted.catch((cause) => {
      this.writeFailure ??= cause instanceof Error ? cause : new Error(String(cause));
      throw this.writeFailure;
    });
    void this.queue.catch(() => undefined);
    return persisted;
  }

  async flush(): Promise<void> {
    this.assertWritable();
    await this.enqueueWrite(async () => { await this.handle?.sync(); });
  }

  close(): Promise<void> {
    return this.closePromise ??= this.closeResources();
  }

  private async closeResources(): Promise<void> {
    let failure: unknown;
    try {
      await Promise.allSettled(this.pendingAppends);
      await this.queue;
      await this.handle?.sync();
    } catch (error) {
      failure = error;
    } finally {
      await this.handle?.close().catch(() => undefined);
      this.handle = undefined;
    }
    if (failure) throw failure;
  }

  private async load(): Promise<void> {
    let content: Buffer;
    try {
      content = await readFile(this.eventsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (content.length > 0 && content.at(-1) !== 0x0a) {
      const newline = content.lastIndexOf(0x0a);
      const validLength = newline < 0 ? 0 : newline + 1;
      await truncate(this.eventsPath, validLength);
      content = content.subarray(0, validLength);
    }
    const lines = content.toString("utf8").split("\n").filter(Boolean);
    for (let index = 0; index < lines.length; index++) {
      try {
        this.projection.apply(JSON.parse(lines[index]!) as AgentTaskRecord);
      } catch (error) {
        throw new Error(`Invalid Agent Task event at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private assertWritable(): void {
    if (this.closePromise) throw new Error("Agent Task repository is closed");
    if (this.writeFailure) throw new Error("Agent Task persistence failed", { cause: this.writeFailure });
  }
}
