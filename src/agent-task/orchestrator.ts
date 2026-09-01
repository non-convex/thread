import { rm } from "node:fs/promises";
import type { UiEventSink } from "../ui/events.js";
import { safeUiEvent } from "../ui/events.js";
import { createId } from "../utils/id.js";
import type { WorkspaceChangeSet } from "../workspace-state/model.js";
import type { WorkspaceStateService } from "../workspace-state/service.js";
import { AgentTaskJournal } from "./journal.js";
import type { AgentTask, AgentTaskStatus, AgentTaskSummary, ImplementationTaskSpec } from "./model.js";
import { IMPLEMENTATION_WORKER_PROFILE_ID, type AgentProfileRegistry } from "./profile.js";
import type { AgentTaskRepository } from "./repository.js";
import { ImplementationTaskRunner } from "./task-runner.js";

const SETTLED_RUN_STATUSES = new Set<AgentTaskStatus>(["awaiting_review", "applied", "failed", "cancelled", "discarded"]);
const FINAL_STATUSES = new Set<AgentTaskStatus>(["applied", "failed", "cancelled", "discarded"]);

export interface DelegateTaskContext {
  parentTurnId: string;
  toolCallId: string;
  signal: AbortSignal;
  ui?: UiEventSink;
}

export interface TaskInspection {
  task: AgentTask;
  summary: AgentTaskSummary;
  content: string;
  nextCursor?: number;
}

export interface AgentTaskOutcome {
  summary: AgentTaskSummary;
  changedPaths: string[];
  scopeViolations: string[];
  finalResponse?: string;
}

export class AgentTaskOrchestrator {
  private readonly runner: ImplementationTaskRunner;
  private readonly controllers = new Map<string, AbortController>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly turnTasks = new Map<string, Set<string>>();
  private readonly reviewedChangeSets = new Set<string>();
  private readonly diffReviewProgress = new Map<string, number>();
  private applyQueue: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(
    readonly repository: AgentTaskRepository,
    readonly profiles: AgentProfileRegistry,
    private readonly workspace: WorkspaceStateService,
  ) {
    this.runner = new ImplementationTaskRunner(repository, workspace);
  }

  get enabled(): boolean {
    return this.profiles.get(IMPLEMENTATION_WORKER_PROFILE_ID) !== undefined && !this.closing;
  }

  async initialize(): Promise<void> {
    for (const task of this.repository.projection.tasks.values()) {
      if (task.status === "preparing" || task.status === "running") {
        await this.captureStaleTask(task).catch(() => undefined);
        await this.repository.append({
          type: "status_changed",
          taskId: task.id,
          status: "cancelled",
          reason: "Thread restarted before the Agent Task completed",
        }, true);
        this.cleanupWorkspace(task.id);
      } else if (task.status === "awaiting_review") {
        await this.repository.append({
          type: "status_changed",
          taskId: task.id,
          status: "discarded",
          reason: "Unmerged Agent Tasks cannot continue across Thread restarts",
        }, true);
        this.cleanupWorkspace(task.id);
      }
    }
  }

  async delegate(specs: readonly ImplementationTaskSpec[], context: DelegateTaskContext): Promise<AgentTaskSummary[]> {
    if (this.closing) throw new Error("Agent Task orchestrator is closing");
    const profile = this.profiles.require(IMPLEMENTATION_WORKER_PROFILE_ID);
    const normalized = specs.map((spec, index) => this.validateSpec(spec, index));
    if (normalized.length < 1 || normalized.length > 2) throw new Error("delegate_tasks accepts one or two tasks");
    for (let left = 0; left < normalized.length; left++) {
      for (let right = left + 1; right < normalized.length; right++) {
        if (this.workspace.scopesOverlap(normalized[left]!.writeScope, normalized[right]!.writeScope)) {
          throw new Error(`Task write scopes overlap: ${normalized[left]!.title} / ${normalized[right]!.title}`);
        }
      }
    }
    const unresolved = [...this.repository.projection.tasks.values()].filter((task) =>
      task.status === "preparing" || task.status === "running" || task.status === "awaiting_review"
    );
    for (const spec of normalized) {
      const overlap = unresolved.find((task) => this.workspace.scopesOverlap(spec.writeScope, task.spec.writeScope));
      if (overlap) throw new Error(`Task ${spec.title} overlaps unresolved task ${overlap.id} (${overlap.spec.title})`);
    }
    const active = [...this.repository.projection.tasks.values()].filter((task) =>
      task.profileId === profile.id && (task.status === "preparing" || task.status === "running")
    ).length;
    if (active + normalized.length > profile.limits.maxConcurrent) {
      throw new Error(`implementation-worker capacity is ${profile.limits.maxConcurrent}; wait for active tasks before delegating more`);
    }

    const tasks: AgentTask[] = [];
    for (const spec of normalized) {
      const now = Date.now();
      const task: AgentTask = {
        id: createId("task"),
        parentTurnId: context.parentTurnId,
        toolCallId: context.toolCallId,
        profileId: profile.id,
        providerId: profile.model.providerId,
        modelId: profile.model.modelId,
        spec,
        status: "preparing",
        createdAt: now,
        updatedAt: now,
        revision: 0,
        runs: [],
        trace: [],
        changeSetIds: [],
        reviewFeedback: [],
      };
      await this.repository.append({ type: "task_created", task }, true);
      tasks.push(task);
      const ids = this.turnTasks.get(context.parentTurnId) ?? new Set<string>();
      ids.add(task.id);
      this.turnTasks.set(context.parentTurnId, ids);
      safeUiEvent(context.ui, { type: "agent_task_created", summary: this.repository.projection.summary(task.id) });
    }

    const staged = await this.workspace.captureStaged();
    for (const task of tasks) {
      const workspacePath = this.workspace.taskWorkspacePath(task.id);
      await this.repository.append({
        type: "task_prepared",
        taskId: task.id,
        baseStateId: staged.state.id,
        workspacePath,
      }, false, staged.persisted);
      this.launch(task.id, profile, context.signal, context.ui, staged.persisted.then(() =>
        this.workspace.materialize(staged.state.id, workspacePath)
      ));
    }
    return tasks.map((task) => this.repository.projection.summary(task.id));
  }

  async waitTasks(taskIds: readonly string[], returnWhen: "first" | "all", signal: AbortSignal): Promise<AgentTaskOutcome[]> {
    const unique = [...new Set(taskIds)];
    if (unique.length === 0) throw new Error("wait_tasks requires at least one task id");
    for (const id of unique) this.repository.projection.require(id);
    const alreadySettled = unique.some((id) => SETTLED_RUN_STATUSES.has(this.repository.projection.require(id).status));
    if (returnWhen === "first" && alreadySettled) return unique.map((id) => this.outcome(id));
    const pending = unique.filter((id) => !SETTLED_RUN_STATUSES.has(this.repository.projection.require(id).status));
    if (pending.length > 0) {
      const waits = pending.map((id) => this.runs.get(id) ?? Promise.resolve());
      await this.abortable(returnWhen === "first" ? Promise.race(waits) : Promise.all(waits).then(() => undefined), signal);
    }
    return unique.map((id) => this.outcome(id));
  }

  async requestRevision(taskId: string, feedback: string, signal: AbortSignal, ui?: UiEventSink): Promise<AgentTaskSummary> {
    const task = this.repository.projection.require(taskId);
    const profile = this.profiles.require(task.profileId);
    if (task.status !== "awaiting_review") throw new Error(`Task ${taskId} is not awaiting review`);
    if (task.revision >= profile.limits.maxRevisions) throw new Error(`Task ${taskId} reached its revision limit`);
    const active = [...this.repository.projection.tasks.values()].filter((candidate) =>
      candidate.profileId === profile.id && (candidate.status === "preparing" || candidate.status === "running")
    ).length;
    if (active >= profile.limits.maxConcurrent) {
      throw new Error(`implementation-worker capacity is ${profile.limits.maxConcurrent}; wait before requesting a revision`);
    }
    if (!feedback.trim()) throw new Error("Revision feedback cannot be empty");
    await this.repository.append({ type: "revision_requested", taskId, feedback: feedback.trim() }, true);
    await new AgentTaskJournal(this.repository, taskId).appendUser(`Review feedback from the main agent:\n\n${feedback.trim()}`);
    await this.repository.append({ type: "status_changed", taskId, status: "preparing" }, true);
    this.launch(taskId, profile, signal, ui);
    return this.repository.projection.summary(taskId);
  }

  async applyTask(taskId: string, changeSetId: string, ui?: UiEventSink): Promise<{ summary: AgentTaskSummary; conflicts: string[] }> {
    let output: { summary: AgentTaskSummary; conflicts: string[] } | undefined;
    const operation = this.applyQueue.then(async () => {
      const task = this.repository.projection.require(taskId);
      if (task.status === "applied" && task.currentChangeSetId === changeSetId) {
        output = { summary: this.repository.projection.summary(taskId), conflicts: [] };
        return;
      }
      if (task.status !== "awaiting_review") throw new Error(`Task ${taskId} is not awaiting review`);
      if (task.currentChangeSetId !== changeSetId) throw new Error(`ChangeSet ${changeSetId} is not the latest candidate for ${taskId}`);
      const changeSet = await this.repository.readChangeSet(changeSetId);
      if (changeSet.scopeViolations.length) throw new Error(`Task ${taskId} changed paths outside its scope: ${changeSet.scopeViolations.join(", ")}`);
      if (!this.reviewedChangeSets.has(changeSetId)) throw new Error(`Inspect the complete diff for ${changeSetId} before applying it`);
      let applied;
      try {
        applied = await this.workspace.applyChangeSet(changeSet);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        await this.repository.append({ type: "integration_failed", taskId, changeSetId, conflicts: [message] }, true);
        safeUiEvent(ui, { type: "agent_task_updated", summary: this.repository.projection.summary(taskId) });
        throw cause;
      }
      if (applied.conflicts.length) {
        const conflicts = applied.conflicts.map((conflict) => `${conflict.path}: ${conflict.reason}`);
        await this.repository.append({ type: "integration_failed", taskId, changeSetId, conflicts }, true);
        safeUiEvent(ui, { type: "agent_task_updated", summary: this.repository.projection.summary(taskId) });
        output = {
          summary: this.repository.projection.summary(taskId),
          conflicts,
        };
        return;
      }
      await this.repository.append({ type: "task_applied", taskId, changeSetId, stateId: applied.mergedStateId }, true);
      const summary = this.repository.projection.summary(taskId);
      safeUiEvent(ui, { type: "agent_task_updated", summary });
      output = { summary, conflicts: [] };
      this.cleanupWorkspace(taskId);
    });
    this.applyQueue = operation.then(() => undefined, () => undefined);
    await operation;
    return output!;
  }

  async cancelTask(taskId: string, reason: string, ui?: UiEventSink): Promise<AgentTaskSummary> {
    const task = this.repository.projection.require(taskId);
    if (task.status === "preparing" || task.status === "running") {
      this.controllers.get(taskId)?.abort(new DOMException(reason, "AbortError"));
      await this.runs.get(taskId);
    } else if (task.status === "awaiting_review") {
      await this.repository.append({ type: "status_changed", taskId, status: "discarded", reason }, true);
      this.cleanupWorkspace(taskId);
    }
    const summary = this.repository.projection.summary(taskId);
    safeUiEvent(ui, { type: "agent_task_updated", summary });
    return summary;
  }

  async inspect(taskId: string, view: "summary" | "diff" | "trace", options: { path?: string; cursor?: number; limit?: number; fullTrace?: boolean } = {}): Promise<TaskInspection> {
    const task = structuredClone(this.repository.projection.require(taskId));
    const summary = this.repository.projection.summary(taskId);
    let source: string;
    if (view === "summary") {
      source = JSON.stringify({ summary, spec: task.spec, runs: task.runs, scopeViolations: this.currentChangeSet(taskId)?.scopeViolations ?? [] }, null, 2);
    } else if (view === "diff") {
      const changeSet = this.currentChangeSet(taskId);
      if (!changeSet) source = "(task has no captured ChangeSet)";
      else source = await this.workspace.reviewDiff(changeSet, options.path);
    } else {
      source = task.trace.map((entry) => {
        if (entry.kind === "tool_execution") return `[tool] ${entry.fact.toolName} ${JSON.stringify(entry.fact.effectiveArgs)}`;
        const text = this.messageText(entry.message);
        return options.fullTrace
          ? `[${entry.message.role}] ${text}`
          : `[${entry.message.role}] ${text.replace(/\s+/g, " ").slice(0, 240)}${text.length > 240 ? "…" : ""}`;
      }).join("\n\n") || "(empty trace)";
    }
    const cursor = Math.max(0, options.cursor ?? 0);
    const limit = Math.min(64_000, Math.max(1_000, options.limit ?? 16_000));
    const content = source.slice(cursor, cursor + limit);
    const nextCursor = cursor + content.length < source.length ? cursor + content.length : undefined;
    if (view === "diff" && !options.path && task.currentChangeSetId) {
      const reviewedThrough = this.diffReviewProgress.get(task.currentChangeSetId) ?? 0;
      if (cursor <= reviewedThrough) {
        const next = Math.max(reviewedThrough, cursor + content.length);
        this.diffReviewProgress.set(task.currentChangeSetId, next);
        if (next >= source.length) this.reviewedChangeSets.add(task.currentChangeSetId);
      }
    }
    return { task, summary, content, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }

  summariesForTurn(turnId: string): AgentTaskSummary[] {
    return [...this.repository.projection.tasks.values()]
      .filter((task) => task.parentTurnId === turnId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((task) => this.repository.projection.summary(task.id));
  }

  async finishParentTurn(turnId: string, reason: string, ui?: UiEventSink): Promise<void> {
    const taskIds = [...(this.turnTasks.get(turnId) ?? [])];
    for (const taskId of taskIds) {
      const status = this.repository.projection.require(taskId).status;
      if (status === "preparing" || status === "running") {
        this.controllers.get(taskId)?.abort(new DOMException(reason, "AbortError"));
      }
    }
    for (const taskId of taskIds) {
      const status = this.repository.projection.require(taskId).status;
      if (!FINAL_STATUSES.has(status)) await this.cancelTask(taskId, reason, ui);
    }
    this.turnTasks.delete(turnId);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort(new DOMException("Thread application closed", "AbortError"));
    await Promise.allSettled(this.runs.values());
    await this.applyQueue;
    for (const task of this.repository.projection.tasks.values()) {
      if (task.status !== "awaiting_review") continue;
      await this.repository.append({
        type: "status_changed",
        taskId: task.id,
        status: "discarded",
        reason: "Thread application closed before the task was applied",
      }, true);
      this.cleanupWorkspace(task.id);
    }
    await this.repository.close();
  }

  referencedStateIds(): Set<string> {
    const ids = new Set<string>();
    for (const task of this.repository.projection.tasks.values()) {
      if (task.baseStateId) ids.add(task.baseStateId);
      if (task.appliedStateId) ids.add(task.appliedStateId);
      for (const changeSetId of task.changeSetIds) {
        const changeSet = this.repository.projection.changeSets.get(changeSetId);
        if (changeSet) {
          ids.add(changeSet.baseStateId);
          ids.add(changeSet.resultStateId);
        }
      }
    }
    return ids;
  }

  private launch(taskId: string, profile: ReturnType<AgentProfileRegistry["require"]>, signal: AbortSignal, ui?: UiEventSink, prepare?: Promise<void>): void {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    this.controllers.set(taskId, controller);
    const run = (async () => {
      try {
        if (prepare) await this.abortable(prepare, combined);
        combined.throwIfAborted();
        await this.runner.run(taskId, profile, combined, ui);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        const task = this.repository.projection.require(taskId);
        if (task.status === "preparing" || task.status === "running") {
          await this.repository.append({
            type: "status_changed",
            taskId,
            status: combined.aborted ? "cancelled" : "failed",
            error: error.message,
            ...(combined.aborted ? { reason: String(combined.reason ?? "Cancelled") } : {}),
          }, true);
        }
      } finally {
        this.controllers.delete(taskId);
        const summary = this.repository.projection.summary(taskId);
        safeUiEvent(ui, { type: "agent_task_updated", summary });
        if (summary.status === "failed" || summary.status === "cancelled") {
          void (prepare ?? Promise.resolve()).finally(() => this.cleanupWorkspace(taskId));
        }
      }
    })();
    this.runs.set(taskId, run);
    void run.catch(() => undefined);
  }

  private currentChangeSet(taskId: string): WorkspaceChangeSet | undefined {
    const task = this.repository.projection.require(taskId);
    return task.currentChangeSetId ? this.repository.projection.changeSets.get(task.currentChangeSetId) : undefined;
  }

  private outcome(taskId: string): AgentTaskOutcome {
    const task = this.repository.projection.require(taskId);
    const changeSet = this.currentChangeSet(taskId);
    const finalResponse = task.runs.at(-1)?.finalResponse;
    return {
      summary: this.repository.projection.summary(taskId),
      changedPaths: changeSet?.operations.map((operation) => operation.path) ?? [],
      scopeViolations: [...(changeSet?.scopeViolations ?? [])],
      ...(finalResponse ? { finalResponse } : {}),
    };
  }

  private validateSpec(spec: ImplementationTaskSpec, index: number): ImplementationTaskSpec {
    const label = `tasks[${index}]`;
    const title = spec.title?.trim();
    const objective = spec.objective?.trim();
    if (!title || !objective) throw new Error(`${label} requires a title and objective`);
    if (!Array.isArray(spec.guidance) || !Array.isArray(spec.acceptanceCriteria) || !Array.isArray(spec.writeScope) || spec.writeScope.length === 0) {
      throw new Error(`${label} requires guidance, acceptanceCriteria and a non-empty writeScope`);
    }
    const writeScope = spec.writeScope.map((scope) => {
      const normalized = scope.path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
      if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..") ||
          (scope.kind !== "file" && scope.kind !== "subtree")) throw new Error(`${label} has an invalid write scope`);
      return { path: normalized, kind: scope.kind };
    });
    const guidance = spec.guidance.map((item) => String(item).trim()).filter(Boolean);
    const acceptanceCriteria = spec.acceptanceCriteria.map((item) => String(item).trim()).filter(Boolean);
    if (guidance.length === 0 || acceptanceCriteria.length === 0) {
      throw new Error(`${label} requires at least one non-empty guidance item and acceptance criterion`);
    }
    return {
      title,
      objective,
      guidance,
      acceptanceCriteria,
      writeScope,
    };
  }

  private async captureStaleTask(task: AgentTask): Promise<void> {
    if (!task.baseStateId || !task.workspacePath) return;
    const result = await this.workspace.captureFrom(task.workspacePath);
    const changeSet = await this.workspace.createChangeSet(task.id, task.baseStateId, result.id, task.spec.writeScope);
    await this.repository.storeChangeSet(changeSet);
    await this.repository.append({ type: "changeset_created", taskId: task.id, changeSetId: changeSet.id }, true);
  }

  private cleanupWorkspace(taskId: string): void {
    const target = this.workspace.taskWorkspacePath(taskId);
    void rm(target, { recursive: true, force: true }).catch(() => undefined);
  }

  private abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private messageText(message: import("@earendil-works/pi-ai").Message): string {
    if (typeof message.content === "string") return message.content;
    return message.content.map((content) => {
      if (content.type === "text") return content.text;
      if (content.type === "thinking") return content.thinking;
      if (content.type === "toolCall") return `${content.name} ${JSON.stringify(content.arguments)}`;
      return "";
    }).filter(Boolean).join("\n");
  }
}
