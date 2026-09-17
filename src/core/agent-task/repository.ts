import path from "node:path";
import type { Project } from "../project/model.js";
import { EventLog, readLogLines } from "../utils/event-log.js";
import { AGENT_TASK_FORMAT, type AgentTaskEvent, type AgentTaskRecord } from "./model.js";
import { AgentTaskProjection } from "./projection.js";

export class AgentTaskRepository {
  readonly projection = new AgentTaskProjection();
  readonly rootPath: string;
  readonly eventsPath: string;
  private readonly log: EventLog<AgentTaskRecord>;

  private constructor(readonly project: Project) {
    this.rootPath = path.join(project.statePath, "agent-tasks");
    this.eventsPath = path.join(this.rootPath, "events.jsonl");
    this.log = new EventLog(this.eventsPath, (record) => this.projection.apply(record));
  }

  static async open(project: Project): Promise<AgentTaskRepository> {
    const repository = new AgentTaskRepository(project);
    const lines = (await readLogLines(repository.eventsPath)).filter(Boolean);
    for (const [index, line] of lines.entries()) {
      try { repository.projection.apply(JSON.parse(line) as AgentTaskRecord); } catch (error) {
        throw new Error(`Invalid Agent Task event at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await repository.log.open();
    return repository;
  }

  async append(event: AgentTaskEvent, flush = false): Promise<void> {
    await this.log.append(() => ({
      format: AGENT_TASK_FORMAT, formatVersion: 2, sequence: this.projection.nextSequence,
      timestamp: Date.now(), ...structuredClone(event),
    }), flush);
  }

  flush(): Promise<void> { return this.log.flush(); }
  close(): Promise<void> { return this.log.close(); }
}
