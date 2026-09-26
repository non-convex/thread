import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FileHistoryService } from "../file-history/service.js";
import type { AgentProfile, AgentProfileRegistry } from "../agent/profile.js";
import type { ExecutionEventSink } from "../runtime/events.js";
import { safeExecutionEvent } from "../runtime/events.js";
import { createId } from "../utils/id.js";
import { AgentTaskJournal } from "./journal.js";
import type { AgentTask, AgentTaskSummary, AgentTaskWriteScope, WorkerTaskSpec } from "./model.js";
import {
  DEFAULT_WORKER_SETTINGS,
  WORKER_PROFILE_ID,
  type WorkerProfileSettings,
} from "./profile.js";
import type { AgentTaskRepository } from "./repository.js";
import { WorkerTaskRunner } from "./task-runner.js";
import type { HostExecutionOptions } from "../runtime/policy.js";
import { validateExecutionLimits } from "../runtime/limits.js";
import { BUILTIN_TOOL_NAMES } from "../tools/builtins.js";

export interface DelegateTaskContext {
  parentTurnId: string;
  toolCallId: string;
  signal: AbortSignal;
  ui?: ExecutionEventSink;
}

export interface AgentTaskOutcome {
  summary: AgentTaskSummary;
  finalResponse?: string;
}

export class AgentTaskOrchestrator {
  private readonly runner: WorkerTaskRunner;
  private readonly runs = new Map<string, { parentTurnId: string; controller: AbortController; done: Promise<void> }>();
  private readonly admissions = new Map<string, Pick<AgentTask, "id" | "profileId" | "spec">>();
  private closing = false;

  constructor(
    readonly repository: AgentTaskRepository,
    readonly profiles: AgentProfileRegistry,
    rootPath: string,
    private readonly workerSettings: WorkerProfileSettings = DEFAULT_WORKER_SETTINGS,
    fileHistory?: FileHistoryService,
    executionOptions: HostExecutionOptions = {},
  ) {
    this.runner = new WorkerTaskRunner(repository, rootPath, fileHistory, executionOptions);
  }

  get enabled(): boolean {
    return this.profiles.get(WORKER_PROFILE_ID) !== undefined && !this.closing;
  }

  async initialize(): Promise<void> {
    for (const task of this.repository.projection.tasks.values()) {
      if (task.status !== "running") continue;
      await this.repository.append({
        type: "status_changed",
        taskId: task.id,
        status: "cancelled",
        reason: "Thread restarted before the Agent Task completed; workspace changes were preserved",
      }, true);
    }
  }

  async delegate(specs: readonly WorkerTaskSpec[], context: DelegateTaskContext): Promise<AgentTaskSummary[]> {
    if (this.closing) throw new Error("Agent Task orchestrator is closing");
    const profile = this.profiles.require(WORKER_PROFILE_ID);
    const normalized = specs.map((spec, index) => this.validateSpec(spec, index));
    if (normalized.length < 1 || normalized.length > 3) throw new Error("delegate_tasks accepts one to three tasks");
    const tasks: AgentTask[] = normalized.map((spec) => {
      const now = Date.now();
      return {
        id: createId("task"),
        parentTurnId: context.parentTurnId,
        toolCallId: context.toolCallId,
        profileId: profile.id,
        providerId: profile.model.providerId,
        modelId: profile.model.modelId,
        spec,
        status: "running",
        createdAt: now,
        updatedAt: now,
        revision: 0,
        runs: [],
        trace: [],
      };
    });
    this.reserveAdmissions(tasks);
    try {
      for (const task of tasks) {
        context.signal.throwIfAborted();
        await this.repository.append({ type: "task_created", task }, true);
        safeExecutionEvent(context.ui, { type: "agent_task_created", summary: this.repository.projection.summary(task.id) });
        this.launch(task.id, profile, context.signal, context.ui);
        this.admissions.delete(task.id);
      }
      return tasks.map((task) => this.repository.projection.summary(task.id));
    } finally {
      for (const task of tasks) this.admissions.delete(task.id);
    }
  }

  async waitTasks(taskIds: readonly string[], returnWhen: "first" | "all", signal: AbortSignal, timeoutMs = 60_000): Promise<{ tasks: AgentTaskOutcome[]; timedOut: boolean }> {
    validateExecutionLimits({ timeoutMs });
    signal.throwIfAborted();
    const unique = [...new Set(taskIds)];
    if (unique.length === 0) throw new Error("wait_tasks requires at least one task id");
    for (const id of unique) this.repository.projection.require(id);
    const pending = unique.flatMap((id) => this.runs.get(id)?.done ?? []);
    let timedOut = false;
    if (pending.length > 0 && (returnWhen === "all" || pending.length === unique.length)) {
      const timer = new AbortController();
      try {
        timedOut = await Promise.race([
          (returnWhen === "first" ? Promise.race(pending) : Promise.all(pending)).then(() => false),
          delay(timeoutMs, true, { signal: AbortSignal.any([signal, timer.signal]) }),
        ]);
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      } finally {
        timer.abort();
      }
    }
    signal.throwIfAborted();
    return { tasks: unique.map((id) => this.outcome(id)), timedOut };
  }

  async requestRevision(taskId: string, feedback: string, signal: AbortSignal, ui?: ExecutionEventSink): Promise<AgentTaskSummary> {
    if (this.closing) throw new Error("Agent Task orchestrator is closing");
    signal.throwIfAborted();
    const task = this.repository.projection.require(taskId);
    const profile = this.profiles.require(task.profileId);
    if (task.status !== "completed") throw new Error(`Task ${taskId} is not completed`);
    if (task.revision >= this.workerSettings.limits.maxRevisions) throw new Error(`Task ${taskId} reached its revision limit`);
    if (!feedback.trim()) throw new Error("Revision feedback cannot be empty");
    this.reserveAdmissions([task]);
    try {
      await new AgentTaskJournal(this.repository, taskId).appendUser(feedback.trim());
      await this.repository.append({ type: "status_changed", taskId, status: "running" }, true);
      this.launch(taskId, profile, signal, ui);
      return this.repository.projection.summary(taskId);
    } finally {
      this.admissions.delete(taskId);
    }
  }

  async cancelTask(taskId: string, reason: string): Promise<AgentTaskSummary> {
    const task = this.repository.projection.require(taskId);
    if (task.status !== "running") {
      throw new Error(`Task ${taskId} is not running; cancellation does not revert workspace changes`);
    }
    await this.cancelRuns([taskId], reason);
    return this.repository.projection.summary(taskId);
  }

  summariesForTurn(turnId: string): AgentTaskSummary[] {
    return [...this.repository.projection.tasks.values()]
      .filter((task) => task.parentTurnId === turnId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((task) => this.repository.projection.summary(task.id));
  }

  finishParentTurn(turnId: string, reason: string): Promise<void> {
    const taskIds = [...this.runs].filter(([, run]) => run.parentTurnId === turnId).map(([id]) => id);
    return this.cancelRuns(taskIds, reason);
  }

  async close(): Promise<void> {
    this.closing = true;
    try {
      await this.cancelRuns([...this.runs.keys()], "Thread application closed; workspace changes were preserved");
    } finally {
      await this.repository.close();
    }
  }

  /** Reserve capacity and scopes before any await; parallel tool calls cannot admit the same work twice. */
  private reserveAdmissions(tasks: readonly Pick<AgentTask, "id" | "profileId" | "spec">[]): void {
    const occupied = new Map<string, Pick<AgentTask, "id" | "profileId" | "spec">>(
      [...this.repository.projection.tasks.values()].filter((task) => task.status === "running").map((task) => [task.id, task]),
    );
    for (const task of this.admissions.values()) occupied.set(task.id, task);
    for (const task of tasks) {
      if (occupied.has(task.id)) throw new Error(`Task ${task.id} is already running or starting`);
      const active = [...occupied.values()];
      if (active.filter((candidate) => candidate.profileId === task.profileId).length >= this.workerSettings.limits.maxConcurrent) {
        throw new Error(`worker capacity is ${this.workerSettings.limits.maxConcurrent}; wait for active tasks before starting more`);
      }
      const overlap = active.find((candidate) => scopesOverlap(task.spec.writeScope, candidate.spec.writeScope));
      if (overlap) throw new Error(`Task ${task.spec.title} overlaps active task ${overlap.id} (${overlap.spec.title})`);
      occupied.set(task.id, task);
    }
    for (const task of tasks) this.admissions.set(task.id, task);
  }

  private async cancelRuns(taskIds: readonly string[], reason: string): Promise<void> {
    const runs = taskIds.flatMap((id) => this.runs.get(id) ?? []);
    for (const run of runs) run.controller.abort(new DOMException(reason, "AbortError"));
    const settled = await Promise.allSettled(runs.map((run) => run.done));
    const failure = settled.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  private launch(taskId: string, profile: AgentProfile, signal: AbortSignal, ui?: ExecutionEventSink): void {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const done = Promise.resolve().then(async () => {
      try {
        combined.throwIfAborted();
        await this.runner.run(taskId, profile, this.workerSettings.limits, combined, ui);
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        const task = this.repository.projection.require(taskId);
        if (task.status === "running") {
          await this.repository.append({
            type: "status_changed",
            taskId,
            status: combined.aborted ? "cancelled" : "failed",
            error: error.message,
            ...(combined.aborted ? { reason: String(combined.reason ?? "Cancelled") } : {}),
          }, true);
        }
      } finally {
        if (this.runs.get(taskId)?.controller === controller) this.runs.delete(taskId);
        safeExecutionEvent(ui, { type: "agent_task_updated", summary: this.repository.projection.summary(taskId) });
      }
    });
    this.runs.set(taskId, { parentTurnId: this.repository.projection.require(taskId).parentTurnId, controller, done });
    void done.catch(() => undefined);
  }

  private outcome(taskId: string): AgentTaskOutcome {
    const task = this.repository.projection.require(taskId);
    const finalResponse = task.runs.at(-1)?.finalResponse;
    return {
      summary: this.repository.projection.summary(taskId),
      ...(finalResponse ? { finalResponse } : {}),
    };
  }

  private validateSpec(spec: WorkerTaskSpec, index: number): WorkerTaskSpec {
    const label = `tasks[${index}]`;
    const title = spec.title?.trim();
    const objective = spec.objective?.trim();
    if (!title || !objective) throw new Error(`${label} requires a title and objective`);
    if (!Array.isArray(spec.guidance) || !Array.isArray(spec.acceptanceCriteria) || !Array.isArray(spec.tools) || !Array.isArray(spec.writeScope)) {
      throw new Error(`${label} requires guidance, acceptanceCriteria, tools and writeScope arrays`);
    }
    const tools = [...spec.tools];
    for (const name of tools) {
      if (!BUILTIN_TOOL_NAMES.includes(name)) throw new Error(`${label} has an unknown built-in tool: ${name}`);
    }
    if (new Set(tools).size !== tools.length) throw new Error(`${label}.tools must not contain duplicates`);
    if ((tools.includes("write") || tools.includes("edit")) && spec.writeScope.length === 0) {
      throw new Error(`${label} requires a non-empty writeScope when write or edit is assigned`);
    }
    const writeScope = spec.writeScope.map((scope) => {
      const input = scope.path.replaceAll("\\", "/").replace(/^\.\//, "");
      const normalized = path.posix.normalize(input).replace(/\/$/, "");
      if (!normalized || normalized === "." || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || input.split("/").includes("..") ||
          (scope.kind !== "file" && scope.kind !== "directory")) throw new Error(`${label} has an invalid write scope`);
      return { path: normalized, kind: scope.kind };
    });
    const guidance = spec.guidance.map((item) => String(item).trim()).filter(Boolean);
    const acceptanceCriteria = spec.acceptanceCriteria.map((item) => String(item).trim()).filter(Boolean);
    if (guidance.length === 0 || acceptanceCriteria.length === 0) {
      throw new Error(`${label} requires at least one non-empty guidance item and acceptance criterion`);
    }
    return { title, objective, guidance, acceptanceCriteria, tools, writeScope };
  }
}

function scopesOverlap(left: readonly AgentTaskWriteScope[], right: readonly AgentTaskWriteScope[]): boolean {
  return left.some((leftScope) => right.some((rightScope) => scopeContains(leftScope, rightScope) || scopeContains(rightScope, leftScope)));
}

function scopeContains(container: AgentTaskWriteScope, candidate: AgentTaskWriteScope): boolean {
  const containerPath = comparableScopePath(container.path);
  const candidatePath = comparableScopePath(candidate.path);
  if (container.kind === "file") return containerPath === candidatePath;
  return candidatePath === containerPath || candidatePath.startsWith(`${containerPath}/`);
}

function comparableScopePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}
