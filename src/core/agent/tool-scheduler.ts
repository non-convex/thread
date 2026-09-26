export interface ScheduledToolCall<T> {
  id: string;
  eager: boolean;
  run(signal: AbortSignal): Promise<T>;
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
 * Calls never wait for other calls in the batch. Non-read effects wait only
 * for releaseResponse(), called after the complete assistant message is durable.
 * The model must place dependent operations in separate steps.
 */
export class ToolScheduler<T> {
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly byId = new Map<string, Promise<T>>();
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
    if (existing) return existing;

    const promise = Promise.resolve().then(async () => {
      if (!call.eager) await waitForRelease(this.signal, this.responseGate);
      this.signal.throwIfAborted();
      return call.run(this.signal);
    });
    // A scheduled call may finish before the batch asks for ordered results.
    // Observe rejection immediately so cancellation never produces an unhandled rejection.
    void promise.catch(() => undefined);

    this.byId.set(call.id, promise);
    return promise;
  }

  releaseResponse(): void {
    if (this.responseReleased) return;
    this.responseReleased = true;
    this.releaseResponseGate();
  }

  result(id: string): Promise<T> | undefined {
    return this.byId.get(id);
  }

  async cancel(reason: unknown = new Error("Tool batch cancelled")): Promise<void> {
    if (!this.controller.signal.aborted) this.controller.abort(reason);
    this.releaseResponse();
    await Promise.allSettled(this.byId.values());
  }
}
