import { mkdir, readFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Project } from "../project/model.js";
import { EventLog, readLogLines } from "../utils/event-log.js";
import { lockFile } from "../utils/file-lock.js";
import { atomicJson } from "../utils/atomic-json.js";
import { SESSION_TREE_FORMAT, type SessionTreeEvent, type SessionTreeRecord } from "./model.js";
import { SessionTreeCorruptionError, SessionTreeProjection } from "./projection.js";

export class SessionTreeRepository {
  readonly projection = new SessionTreeProjection();
  readonly treePath: string;
  readonly eventsPath: string;
  private readonly log: EventLog<SessionTreeRecord>;
  private lock: FileHandle | undefined;
  private closing: Promise<void> | undefined;

  private constructor(readonly project: Project) {
    this.treePath = path.join(project.statePath, "session-tree");
    this.eventsPath = path.join(this.treePath, "events.jsonl");
    this.log = new EventLog(this.eventsPath, (record) => this.projection.applyRecord(record));
  }

  static async open(project: Project): Promise<SessionTreeRepository> {
    const repository = new SessionTreeRepository(project);
    await mkdir(repository.treePath, { recursive: true });
    try {
      repository.lock = await lockFile(path.join(project.statePath, "session-tree.lock"));
      await repository.load();
      await repository.log.open();
      return repository;
    } catch (error) {
      await repository.close();
      throw error;
    }
  }

  private async load(): Promise<void> {
    const manifestPath = path.join(this.treePath, "tree.json");
    let manifest: { format?: unknown; formatVersion?: unknown; id?: unknown; projectId?: unknown } | undefined;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (manifest?.format !== SESSION_TREE_FORMAT || manifest.formatVersion !== 3) {
        throw new Error(`Unsupported Session Tree manifest at ${manifestPath}; old data is not loaded`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const lines = await readLogLines(this.eventsPath);
    if (!lines.length) {
      if (manifest) throw new Error(`Session Tree manifest exists but its event log is missing or empty: ${this.eventsPath}`);
      return;
    }
    for (const [index, line] of lines.entries()) {
      try { this.projection.applyRecord(JSON.parse(line) as SessionTreeRecord); } catch (error) {
        if (error instanceof SyntaxError) throw new SessionTreeCorruptionError(`Invalid JSON at line ${index + 1}: ${error.message}`);
        throw error;
      }
    }
    const tree = this.projection.tree;
    if (tree?.format !== SESSION_TREE_FORMAT) {
      throw new Error("This project contains unsupported or old Thread data; migration and compatibility are disabled");
    }
    if (manifest && (manifest.id !== tree.id || manifest.projectId !== tree.projectId)) {
      throw new Error(`Session Tree manifest does not match its event log: ${manifestPath}`);
    }
  }

  async append(factory: (sequence: number, timestamp: number) => SessionTreeEvent | { type: "batch"; events: SessionTreeEvent[] }, flush = false): Promise<number> {
    const record = await this.log.append(() => {
      const sequence = this.projection.nextSequence;
      const timestamp = Date.now();
      return { sequence, timestamp, ...factory(sequence, timestamp) };
    }, flush);
    return record.sequence;
  }

  appendBatch(factory: (sequence: number, timestamp: number) => SessionTreeEvent[], flush = false): Promise<number> {
    return this.append((sequence, timestamp) => ({ type: "batch", events: factory(sequence, timestamp) }), flush);
  }

  async writeManifest(): Promise<void> {
    if (!this.projection.tree) throw new Error("Cannot write a manifest before creating the Session Tree");
    const tree = structuredClone(this.projection.tree);
    return this.log.write(() => atomicJson(path.join(this.treePath, "tree.json"), tree, { pretty: true }));
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      let failure: unknown;
      try { await this.log.close(); } catch (error) { failure = error; }
      await this.lock?.close().catch((error) => { failure ??= error; });
      this.lock = undefined;
      if (failure !== undefined) throw failure;
    })();
  }
}
