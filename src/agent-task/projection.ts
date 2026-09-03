import { calculateContextTokens } from "../context/usage.js";
import { AGENT_TASK_FORMAT, type AgentTask, type AgentTaskRecord, type AgentTaskSummary } from "./model.js";

export class AgentTaskProjection {
  readonly tasks = new Map<string, AgentTask>();
  nextSequence = 1;

  apply(record: AgentTaskRecord): void {
    if (record.format !== AGENT_TASK_FORMAT || record.formatVersion !== 2) throw new Error("Unsupported Agent Task record");
    if (record.sequence !== this.nextSequence) throw new Error(`Expected Agent Task sequence ${this.nextSequence}, got ${record.sequence}`);
    switch (record.type) {
      case "task_created":
        if (this.tasks.has(record.task.id)) throw new Error(`Duplicate Agent Task ${record.task.id}`);
        this.tasks.set(record.task.id, structuredClone(record.task));
        break;
      case "run_started": {
        const task = this.require(record.taskId);
        task.status = "running";
        task.revision = record.run.revision;
        task.runs.push(structuredClone(record.run));
        delete task.error;
        delete task.cancelReason;
        task.updatedAt = record.timestamp;
        break;
      }
      case "run_progress": {
        const task = this.require(record.taskId);
        const run = task.runs.findLast((candidate) => candidate.revision === record.revision);
        if (!run) throw new Error(`Agent Task ${task.id} has no run ${record.revision}`);
        run.usage = structuredClone(record.usage);
        task.updatedAt = record.timestamp;
        break;
      }
      case "trace_message":
      case "trace_tool_execution": {
        const task = this.require(record.taskId);
        task.trace.push(structuredClone(record.entry));
        task.updatedAt = record.timestamp;
        break;
      }
      case "run_finished": {
        const task = this.require(record.taskId);
        const run = task.runs.findLast((candidate) => candidate.revision === record.run.revision);
        if (!run) throw new Error(`Agent Task ${task.id} has no run ${record.run.revision}`);
        Object.assign(run, structuredClone(record.run));
        task.updatedAt = record.timestamp;
        break;
      }
      case "revision_requested": {
        const task = this.require(record.taskId);
        task.reviewFeedback.push(record.feedback);
        task.updatedAt = record.timestamp;
        break;
      }
      case "status_changed": {
        const task = this.require(record.taskId);
        task.status = record.status;
        if (record.error !== undefined) task.error = record.error;
        if (record.reason !== undefined) task.cancelReason = record.reason;
        task.updatedAt = record.timestamp;
        break;
      }
    }
    this.nextSequence++;
  }

  summary(taskId: string, now = Date.now()): AgentTaskSummary {
    const task = this.require(taskId);
    const latestRun = task.runs.at(-1);
    const latestAssistant = task.trace.findLast((entry) => entry.kind === "message" && entry.message.role === "assistant");
    return {
      taskId: task.id,
      parentTurnId: task.parentTurnId,
      toolCallId: task.toolCallId,
      title: task.spec.title,
      status: task.status,
      profileId: task.profileId,
      providerId: task.providerId,
      modelId: task.modelId,
      revision: task.revision,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      elapsedMs: Math.max(0, (latestRun?.finishedAt ?? now) - (latestRun?.startedAt ?? task.createdAt)),
      contextTokens: latestAssistant?.kind === "message" && latestAssistant.message.role === "assistant"
        ? calculateContextTokens(latestAssistant.message.usage)
        : 0,
      ...(latestRun?.usage ? { usage: structuredClone(latestRun.usage) } : {}),
      ...(task.error ? { error: task.error } : {}),
    };
  }

  require(taskId: string): AgentTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown Agent Task: ${taskId}`);
    return task;
  }
}
