import type { ThreadRuntime } from "../../core/runtime/thread-runtime.js";
import type { ScheduleSummary } from "../../core/scheduling/model.js";
import { ephemeral, viewResult, type CommandResult, type ThreadCommandContext } from "./types.js";

const USAGE = "Usage: /schedule [list|open <id>|pause <id>|resume <id>|delete <id>]. Ask the agent to create a task.";

function scheduleStatus(task: ScheduleSummary): string {
  if (task.lastRun?.status === "running") return "running";
  return task.enabled ? "enabled" : task.nextRunAt === null ? "no further wakeups" : "paused";
}

function formatSchedule(task: ScheduleSummary): string {
  const last = task.lastRun
    ? `${task.lastRun.status} (${task.lastRun.turnId}, ${new Date(task.lastRun.startedAt).toISOString()})${task.lastRun.error ? ` · ${task.lastRun.error}` : ""}`
    : "never";
  return [
    `${task.id} · ${task.name} · ${scheduleStatus(task)}`,
    `  session: ${task.sessionId}`,
    `  next: ${task.nextRunAt === null ? "none" : new Date(task.nextRunAt).toISOString()}`,
    `  last turn: ${last}`,
    `  open: /schedule open ${task.id}`,
    ...(task.lastError ? [`  error: ${task.lastError}`] : []),
  ].join("\n");
}

export async function scheduleCommand(args: string[], context:
  Pick<ThreadCommandContext, "signal" | "selectedSessionId" | "openSession"> & { runtime: ThreadRuntime }): Promise<CommandResult> {
  const { runtime, signal } = context;
  signal.throwIfAborted();
  if (!runtime.schedulingEnabled) return ephemeral("Scheduling is disabled for this application.");
  const action = args[0] ?? "list";
  if (action === "list" && args.length <= 1) {
    const tasks = runtime.listSchedules();
    const content = `${tasks.length ? tasks.map(formatSchedule).join("\n\n") : "No scheduled tasks."}\n\n${USAGE}`;
    return viewResult(content, {
      type: "command_picker", title: "Scheduled tasks · choose a task to view its Session",
      items: tasks.map((task) => ({
        label: task.name,
        description: `${scheduleStatus(task)} · ${task.id} · Session ${task.sessionId}`,
        command: `/schedule open ${task.id}`, submit: true, current: task.sessionId === context.selectedSessionId,
      })),
      emptyText: "No scheduled tasks. Ask the agent to create one.",
    });
  }
  if (args.length !== 2 || !["open", "pause", "resume", "delete"].includes(action)) throw new Error(USAGE);
  const id = args[1]!;
  if (action === "open") {
    const matches = runtime.listSchedules().filter((task) => task.id.startsWith(id));
    if (!id || matches.length !== 1) throw new Error(`Could not uniquely resolve schedule: ${id}`);
    const task = matches[0]!;
    const session = await context.openSession(task.sessionId);
    return ephemeral(`Opened ${task.name} · Session ${session.id}. Viewing does not interrupt its execution.`, true);
  }
  if (action === "delete") {
    await runtime.deleteSchedule(id, { signal });
    return ephemeral(`Deleted schedule ${id}.`, true);
  }
  const updated = await runtime.setScheduleEnabled(id, action === "resume", { signal });
  return ephemeral(`${action === "resume" ? "Resumed" : "Paused"} schedule ${updated.id}.`, true);
}
