import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, truncate, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Project } from "../project/model.js";
import { sha256 } from "../utils/id.js";
import { WORKSPACE_CHANGE_SET_FORMAT, type WorkspaceChangeSet } from "../workspace-state/model.js";
import { AGENT_TASK_FORMAT, type AgentTaskEvent, type AgentTaskRecord } from "./model.js";
import { AgentTaskProjection } from "./projection.js";

export class AgentTaskRepository {
  readonly projection = new AgentTaskProjection();
  readonly rootPath: string;
  readonly eventsPath: string;
  readonly changesetsPath: string;
  readonly workspacesPath: string;
  private handle: FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();
  private writeFailure: Error | undefined;

  private constructor(readonly project: Project) {
    this.rootPath = path.join(project.statePath, "agent-tasks");
    this.eventsPath = path.join(this.rootPath, "events.jsonl");
    this.changesetsPath = path.join(this.rootPath, "changesets");
    this.workspacesPath = path.join(this.rootPath, "workspaces");
  }

  static async open(project: Project): Promise<AgentTaskRepository> {
    const repository = new AgentTaskRepository(project);
    await Promise.all([
      mkdir(repository.changesetsPath, { recursive: true }),
      mkdir(repository.workspacesPath, { recursive: true }),
    ]);
    await repository.load();
    repository.handle = await open(repository.eventsPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o600);
    return repository;
  }

  async append(event: AgentTaskEvent, flush = false, persistAfter?: Promise<unknown>): Promise<void> {
    this.assertWritable();
    if (flush) await this.flushQueue();
    const record: AgentTaskRecord = {
      format: AGENT_TASK_FORMAT,
      formatVersion: 1,
      sequence: this.projection.nextSequence,
      timestamp: Date.now(),
      ...structuredClone(event),
    };
    this.projection.apply(record);
    const persisted = this.queue.then(async () => {
      await persistAfter;
      if (!this.handle) throw new Error("Agent Task repository is closed");
      await this.handle.write(`${JSON.stringify(record)}\n`, undefined, "utf8");
      if (flush) await this.handle.sync();
    });
    this.queue = persisted.catch((cause) => {
      this.writeFailure ??= cause instanceof Error ? cause : new Error(String(cause));
      throw this.writeFailure;
    });
    void this.queue.catch(() => undefined);
    if (flush) await persisted;
  }

  async storeChangeSet(changeSet: WorkspaceChangeSet): Promise<void> {
    this.validateChangeSet(changeSet);
    const target = this.changeSetPath(changeSet.id);
    let existing: string | undefined;
    try {
      existing = await readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const content = `${JSON.stringify(changeSet)}\n`;
    if (existing !== undefined && existing !== content) throw new Error(`ChangeSet id collision: ${changeSet.id}`);
    if (existing === undefined) await this.atomicWrite(target, content);
    this.projection.changeSets.set(changeSet.id, structuredClone(changeSet));
  }

  async readChangeSet(changeSetId: string): Promise<WorkspaceChangeSet> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.changeSetPath(changeSetId), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`ChangeSet is missing: ${changeSetId}`);
      throw error;
    }
    const changeSet = parsed as WorkspaceChangeSet;
    this.validateChangeSet(changeSet);
    return changeSet;
  }

  async flush(): Promise<void> {
    await this.flushQueue();
    await this.handle?.sync();
  }

  async close(): Promise<void> {
    let failure: unknown;
    try {
      await this.flush();
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
        const record = JSON.parse(lines[index]!) as AgentTaskRecord;
        if (record.type === "changeset_created") {
          this.projection.changeSets.set(record.changeSetId, await this.readChangeSet(record.changeSetId));
        }
        this.projection.apply(record);
      } catch (error) {
        throw new Error(`Invalid Agent Task event at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private validateChangeSet(changeSet: WorkspaceChangeSet): void {
    if (!/^change_[0-9a-f]{64}$/.test(changeSet.id) || changeSet.format !== WORKSPACE_CHANGE_SET_FORMAT ||
        changeSet.formatVersion !== 1 || !Array.isArray(changeSet.operations) || !Array.isArray(changeSet.scopeViolations)) {
      throw new Error("Invalid thread-change-set-v1 manifest");
    }
    const { id: _id, ...body } = changeSet;
    if (`change_${sha256(JSON.stringify(body))}` !== changeSet.id) throw new Error(`ChangeSet digest is invalid: ${changeSet.id}`);
  }

  private changeSetPath(changeSetId: string): string {
    if (!/^change_[0-9a-f]{64}$/.test(changeSetId)) throw new Error(`Invalid ChangeSet id: ${changeSetId}`);
    return path.join(this.changesetsPath, `${changeSetId}.json`);
  }

  private async atomicWrite(target: string, content: string): Promise<void> {
    const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await writeFile(temporary, content, "utf8");
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async flushQueue(): Promise<void> {
    await this.queue;
    this.assertWritable();
  }

  private assertWritable(): void {
    if (this.writeFailure) throw new Error("Agent Task persistence failed", { cause: this.writeFailure });
  }
}
