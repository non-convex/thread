import type { ScheduledTask } from "./model.js";

export class ScheduleScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private pending: Promise<void> | undefined;

  constructor(private readonly hooks: {
    list: () => ScheduledTask[];
    wake: (id: string) => Promise<void>;
    onError: (id: string, error: unknown) => void | Promise<void>;
  }) {}

  /** Schedules only while the host process is online. The first scan waits one second. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1_000);
    this.timer.unref();
  }

  /** Cancel future scans synchronously; allow an in-flight wake/error report to settle. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }

  private tick(): void {
    if (!this.timer || this.pending) return;
    const run = this.runTick();
    this.pending = run;
    // runTick handles errors from list, wake and onError; no rejection escapes the timer callback.
    void run.then(() => {
      if (this.pending === run) this.pending = undefined;
    });
  }

  private async runTick(): Promise<void> {
    let id = "";
    try {
      const now = Date.now();
      let due: ScheduledTask | undefined;
      for (const task of this.hooks.list()) {
        if (task.enabled && task.nextRunAt !== null && task.nextRunAt <= now &&
          (!due || task.nextRunAt < due.nextRunAt!)) due = task;
      }
      if (!due) return;
      id = due.id;
      // A busy host may do nothing; the task remains due and is tried again next second.
      await this.hooks.wake(id);
    } catch (error) {
      try {
        await this.hooks.onError(id, error);
      } catch {
        // Reporting failures must not become unhandled timer rejections.
      }
    }
  }
}
