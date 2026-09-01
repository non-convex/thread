import type { WorkspaceChangeSet } from "../workspace-state/model.js";
import { calculateContextTokens } from "../utils/estimate.js";
import { AGENT_TASK_FORMAT, type AgentTask, type AgentTaskRecord, type AgentTaskSummary } from "./model.js";

export class AgentTaskProjection {
  readonly tasks = new Map<string, AgentTask>();
  readonly changeSets = new Map<string, WorkspaceChangeSet>();
  nextSequence = 1;

  apply(record: AgentTaskRecord): void {
    if (record.format !== AGENT_TASK_FORMAT || record.formatVersion !== 1) throw new Error("Unsupported Agent Task record");
    if (record.sequence !== this.nextSequence) throw new Error(`Expected Agent Task sequence ${this.nextSequence}, got ${record.sequence}`);
    switch (record.type) {
      case "task_created":
        if (this.tasks.has(record.task.id)) throw new Error(`Duplicate Agent Task ${record.task.id}`);
        this.tasks.set(record.task.id, structuredClone(record.task));
        break;
      case "task_prepared": {
        const task = this.require(record.taskId);
        task.baseStateId = record.baseStateId;
        task.workspacePath = record.workspacePath;
        task.updatedAt = record.timestamp;
        break;
      }
      case "run_started": {
        const task = this.require(record.taskId);
        task.status = "running";
        task.revision = record.run.revision;
        task.runs.push(structuredClone(record.run));
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
      case "changeset_created": {
        const task = this.require(record.taskId);
        if (!this.changeSets.has(record.changeSetId)) throw new Error(`ChangeSet manifest was not loaded: ${record.changeSetId}`);
        task.currentChangeSetId = record.changeSetId;
        if (!task.changeSetIds.includes(record.changeSetId)) task.changeSetIds.push(record.changeSetId);
        task.updatedAt = record.timestamp;
        break;
      }
      case "revision_requested": {
        const task = this.require(record.taskId);
        task.reviewFeedback.push(record.feedback);
        delete task.currentChangeSetId;
        delete task.integrationError;
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
      case "task_applied": {
        const task = this.require(record.taskId);
        task.status = "applied";
        task.appliedStateId = record.stateId;
        delete task.integrationError;
        task.updatedAt = record.timestamp;
        break;
      }
      case "integration_failed": {
        const task = this.require(record.taskId);
        task.integrationError = record.conflicts.join("; ");
        task.updatedAt = record.timestamp;
        break;
      }
    }
    this.nextSequence++;
  }

  summary(taskId: string, now = Date.now()): AgentTaskSummary {
    const task = this.require(taskId);
    const changeSet = task.currentChangeSetId ? this.changeSets.get(task.currentChangeSetId) : undefined;
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
      changedFiles: changeSet?.operations.filter((operation) => {
        if (operation.kind === "create") return operation.after.kind !== "directory";
        if (operation.kind === "delete") return operation.before.kind !== "directory";
        return operation.before.kind !== "directory" || operation.after.kind !== "directory";
      }).length ?? 0,
      scopeViolations: [...(changeSet?.scopeViolations ?? [])],
      ...(task.currentChangeSetId ? { changeSetId: task.currentChangeSetId } : {}),
      ...(latestRun?.usage ? { usage: structuredClone(latestRun.usage) } : {}),
      ...(task.error || task.integrationError ? { error: task.error ?? task.integrationError } : {}),
    };
  }

  require(taskId: string): AgentTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown Agent Task: ${taskId}`);
    return task;
  }
}
