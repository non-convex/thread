import path from "node:path";
import type { AgentProfile, AgentProfileRegistry } from "../agent/profile.js";
import type { UiEventSink } from "../ui/events.js";
import { safeUiEvent } from "../ui/events.js";
import { createId } from "../utils/id.js";
import { AgentTaskJournal } from "./journal.js";
import type { AgentTask, AgentTaskSummary, AgentTaskWriteScope, ImplementationTaskSpec } from "./model.js";
import {
  DEFAULT_IMPLEMENTATION_WORKER_SETTINGS,
  IMPLEMENTATION_WORKER_PROFILE_ID,
  type ImplementationWorkerProfileSettings,
} from "./profile.js";
import type { AgentTaskRepository } from "./repository.js";
import { ImplementationTaskRunner } from "./task-runner.js";

export interface DelegateTaskContext {
  parentTurnId: string;
  toolCallId: string;
  signal: AbortSignal;
  ui?: UiEventSink;
}

export interface AgentTaskOutcome {
  summary: AgentTaskSummary;
  finalResponse?: string;
}

export class AgentTaskOrchestrator {
  private readonly runner: ImplementationTaskRunner;
  private readonly controllers = new Map<string, AbortController>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly turnTasks = new Map<string, Set<string>>();
  private closing = false;

  constructor(
    readonly repository: AgentTaskRepository,
    readonly profiles: AgentProfileRegistry,
    rootPath: string,
    private readonly workerSettings: ImplementationWorkerProfileSettings = DEFAULT_IMPLEMENTATION_WORKER_SETTINGS,
  ) {
    this.runner = new ImplementationTaskRunner(repository, rootPath);
  }

  get enabled(): boolean {
    return this.profiles.get(IMPLEMENTATION_WORKER_PROFILE_ID) !== undefined && !this.closing;
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

  async delegate(specs: readonly ImplementationTaskSpec[], context: DelegateTaskContext): Promise<AgentTaskSummary[]> {
    if (this.closing) throw new Error("Agent Task orchestrator is closing");
    const profile = this.profiles.require(IMPLEMENTATION_WORKER_PROFILE_ID);
    const normalized = specs.map((spec, index) => this.validateSpec(spec, index));
    if (normalized.length < 1 || normalized.length > 2) throw new Error("delegate_tasks accepts one or two tasks");
    for (let left = 0; left < normalized.length; left++) {
      for (let right = left + 1; right < normalized.length; right++) {
        if (scopesOverlap(normalized[left]!.writeScope, normalized[right]!.writeScope)) {
          throw new Error(`Task write scopes overlap: ${normalized[left]!.title} / ${normalized[right]!.title}`);
        }
      }
    }
    const running = [...this.repository.projection.tasks.values()].filter((task) => task.status === "running");
    for (const spec of normalized) {
      const overlap = running.find((task) => scopesOverlap(spec.writeScope, task.spec.writeScope));
      if (overlap) throw new Error(`Task ${spec.title} overlaps running task ${overlap.id} (${overlap.spec.title})`);
    }
    const active = running.filter((task) => task.profileId === profile.id).length;
    if (active + normalized.length > this.workerSettings.limits.maxConcurrent) {
      throw new Error(`implementation-worker capacity is ${this.workerSettings.limits.maxConcurrent}; wait for active tasks before delegating more`);
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
        status: "running",
        createdAt: now,
        updatedAt: now,
        revision: 0,
        runs: [],
        trace: [],
        reviewFeedback: [],
      };
      await this.repository.append({ type: "task_created", task }, true);
      tasks.push(task);
      const ids = this.turnTasks.get(context.parentTurnId) ?? new Set<string>();
      ids.add(task.id);
      this.turnTasks.set(context.parentTurnId, ids);
      safeUiEvent(context.ui, { type: "agent_task_created", summary: this.repository.projection.summary(task.id) });
      this.launch(task.id, profile, context.signal, context.ui);
    }
    return tasks.map((task) => this.repository.projection.summary(task.id));
  }

  async waitTasks(taskIds: readonly string[], returnWhen: "first" | "all", signal: AbortSignal): Promise<AgentTaskOutcome[]> {
    const unique = [...new Set(taskIds)];
    if (unique.length === 0) throw new Error("wait_tasks requires at least one task id");
    for (const id of unique) this.repository.projection.require(id);
    const pending = unique.filter((id) => this.repository.projection.require(id).status === "running");
    if (returnWhen === "first" && pending.length < unique.length) return unique.map((id) => this.outcome(id));
    if (pending.length > 0) {
      const waits = pending.map((id) => this.runs.get(id) ?? Promise.resolve());
      await abortable(returnWhen === "first" ? Promise.race(waits) : Promise.all(waits).then(() => undefined), signal);
    }
    return unique.map((id) => this.outcome(id));
  }

  async requestRevision(taskId: string, feedback: string, signal: AbortSignal, ui?: UiEventSink): Promise<AgentTaskSummary> {
    const task = this.repository.projection.require(taskId);
    const profile = this.profiles.require(task.profileId);
    if (task.status !== "completed") throw new Error(`Task ${taskId} is not completed`);
    if (task.revision >= this.workerSettings.limits.maxRevisions) throw new Error(`Task ${taskId} reached its revision limit`);
    if (!feedback.trim()) throw new Error("Revision feedback cannot be empty");
    const running = [...this.repository.projection.tasks.values()].filter((candidate) => candidate.status === "running");
    if (running.filter((candidate) => candidate.profileId === profile.id).length >= this.workerSettings.limits.maxConcurrent) {
      throw new Error(`implementation-worker capacity is ${this.workerSettings.limits.maxConcurrent}; wait before requesting a revision`);
    }
    const overlap = running.find((candidate) => candidate.id !== taskId && scopesOverlap(task.spec.writeScope, candidate.spec.writeScope));
    if (overlap) throw new Error(`Task ${taskId} overlaps running task ${overlap.id} (${overlap.spec.title})`);
    await this.repository.append({ type: "revision_requested", taskId, feedback: feedback.trim() }, true);
    await new AgentTaskJournal(this.repository, taskId).appendUser(`Review feedback from the main agent:\n\n${feedback.trim()}`);
    await this.repository.append({ type: "status_changed", taskId, status: "running" }, true);
    this.launch(taskId, profile, signal, ui);
    return this.repository.projection.summary(taskId);
  }

  async cancelTask(taskId: string, reason: string, ui?: UiEventSink): Promise<AgentTaskSummary> {
    const task = this.repository.projection.require(taskId);
    if (task.status !== "running") {
      throw new Error(`Task ${taskId} is not running; cancellation does not revert workspace changes`);
    }
    this.controllers.get(taskId)?.abort(new DOMException(reason, "AbortError"));
    await this.runs.get(taskId);
    const summary = this.repository.projection.summary(taskId);
    safeUiEvent(ui, { type: "agent_task_updated", summary });
    return summary;
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
      if (this.repository.projection.require(taskId).status === "running") {
        await this.cancelTask(taskId, reason, ui);
      }
    }
    this.turnTasks.delete(turnId);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers.values()) {
      controller.abort(new DOMException("Thread application closed; workspace changes were preserved", "AbortError"));
    }
    await Promise.allSettled(this.runs.values());
    await this.repository.close();
  }

  private launch(taskId: string, profile: AgentProfile, signal: AbortSignal, ui?: UiEventSink): void {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    this.controllers.set(taskId, controller);
    const run = (async () => {
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
        this.controllers.delete(taskId);
        safeUiEvent(ui, { type: "agent_task_updated", summary: this.repository.projection.summary(taskId) });
      }
    })();
    this.runs.set(taskId, run);
    void run.catch(() => undefined);
  }

  private outcome(taskId: string): AgentTaskOutcome {
    const task = this.repository.projection.require(taskId);
    const finalResponse = task.runs.at(-1)?.finalResponse;
    return {
      summary: this.repository.projection.summary(taskId),
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
    return { title, objective, guidance, acceptanceCriteria, writeScope };
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

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
