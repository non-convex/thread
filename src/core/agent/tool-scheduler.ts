import type { ToolExecutionMode, ToolResourceClaim } from "../tools/execution.js";

export interface ScheduledToolCall<T> {
  id: string;
  mode: ToolExecutionMode;
  eager: boolean;
  resources: readonly ToolResourceClaim[];
  run(signal: AbortSignal): Promise<T>;
}

interface ScheduledTask<T> {
  call: ScheduledToolCall<T>;
  promise: Promise<T>;
}

function pathContains(parent: string, child: string): boolean {
  if (parent === child) return true;
  const separator = parent.includes("\\") ? "\\" : "/";
  return child.startsWith(parent.endsWith(separator) ? parent : `${parent}${separator}`);
}

function resourcesOverlap(left: ToolResourceClaim, right: ToolResourceClaim): boolean {
  if (left.namespace !== right.namespace) return false;
  if (left.resource === "*" || right.resource === "*") return true;
  if (left.resource === right.resource) return true;
  if ((left.scope ?? "exact") === "subtree" && pathContains(left.resource, right.resource)) return true;
  return (right.scope ?? "exact") === "subtree" && pathContains(right.resource, left.resource);
}

export function resourceClaimsConflict(
  left: readonly ToolResourceClaim[],
  right: readonly ToolResourceClaim[],
): boolean {
  for (const first of left) {
    for (const second of right) {
      if (first.access === "read" && second.access === "read") continue;
      if (resourcesOverlap(first, second)) return true;
    }
  }
  return false;
}

function waitForRelease(signal: AbortSignal, release: Promise<void>): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    release.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Schedules one assistant message's tool calls.
 *
 * Calls are registered in assistant source order. Parallel calls wait only for
 * earlier conflicting resources and the most recent sequential barrier.
 * Sequential calls wait for every earlier call and become a barrier for every
 * later call. Non-read effects additionally wait for releaseResponse(), which
 * is called only after the complete assistant message is durable.
 */
export class ToolScheduler<T> {
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly tasks: ScheduledTask<T>[] = [];
  private readonly byId = new Map<string, ScheduledTask<T>>();
  private lastSequential: Promise<unknown> | undefined;
  private releaseResponseGate!: () => void;
  private readonly responseGate = new Promise<void>((resolve) => {
    this.releaseResponseGate = resolve;
  });
  private responseReleased = false;

  constructor(parentSignal: AbortSignal) {
    this.signal = AbortSignal.any([parentSignal, this.controller.signal]);
  }

  schedule(call: ScheduledToolCall<T>): Promise<T> {
    const existing = this.byId.get(call.id);
    if (existing) return existing.promise;

    const dependencies = new Set<Promise<unknown>>();
    if (this.lastSequential) dependencies.add(this.lastSequential);
    if (call.mode === "sequential") {
      for (const task of this.tasks) dependencies.add(task.promise);
    } else {
      for (const task of this.tasks) {
        if (resourceClaimsConflict(task.call.resources, call.resources)) dependencies.add(task.promise);
      }
    }

    const promise = (async () => {
      await Promise.all(dependencies);
      if (!call.eager) await waitForRelease(this.signal, this.responseGate);
      this.signal.throwIfAborted();
      return call.run(this.signal);
    })();
    // A scheduled call may finish before the batch asks for ordered results.
    // Observe rejection immediately so cancellation never produces an unhandled rejection.
    void promise.catch(() => undefined);

    const task = { call, promise };
    this.tasks.push(task);
    this.byId.set(call.id, task);
    if (call.mode === "sequential") this.lastSequential = promise;
    return promise;
  }

  releaseResponse(): void {
    if (this.responseReleased) return;
    this.responseReleased = true;
    this.releaseResponseGate();
  }

  result(id: string): Promise<T> | undefined {
    return this.byId.get(id)?.promise;
  }

  async cancel(reason: unknown = new Error("Tool batch cancelled")): Promise<void> {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
    this.releaseResponse();
    await Promise.allSettled(this.tasks.map((task) => task.promise));
  }
}
