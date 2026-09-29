import type { ScheduledTask } from "./model.js";

export class ScheduleScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly pending = new Map<string, Promise<void>>();

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
    await Promise.all(this.pending.values());
  }

  private tick(): void {
    if (!this.timer) return;
    try {
      const now = Date.now();
      const due = this.hooks.list().filter((task) => task.enabled && task.nextRunAt !== null && task.nextRunAt <= now)
        .sort((left, right) => left.nextRunAt! - right.nextRunAt!);
      for (const task of due) {
        if (this.pending.has(task.id)) continue;
        // Each wake reserves its Session synchronously. A busy Session stays due;
        // it cannot hold up schedules targeting other Sessions.
        const run = this.wake(task.id).finally(() => { this.pending.delete(task.id); });
        this.pending.set(task.id, run);
      }
    } catch (error) {
      void this.reportError("", error);
    }
  }

  private async wake(id: string): Promise<void> {
    try { await this.hooks.wake(id); }
    catch (error) { await this.reportError(id, error); }
  }

  private async reportError(id: string, error: unknown): Promise<void> {
    try { await this.hooks.onError(id, error); }
    catch { /* Reporting failures must not become unhandled timer rejections. */ }
  }
}
