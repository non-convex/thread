import { Type } from "@earendil-works/pi-ai";
import { singletonResource } from "../tools/execution.js";
import { fail, ok } from "../tools/results.js";
import type { AgentTool, ToolContext } from "../tools/types.js";
import type { ScheduleHost, ScheduleSpec } from "./model.js";
import { normalizeSchedule } from "./timing.js";

function requireMain(context: ToolContext): void {
  context.signal.throwIfAborted();
  if (context.invocation.agentId !== "main" || context.invocation.taskId) {
    throw new Error("Schedule tools are available only to the main agent");
  }
}

const scheduleSchema = Type.Union([
  Type.Object({ kind: Type.Literal("at"), at: Type.String({ description: "ISO date-time with explicit offset or Z." }) }),
  Type.Object({ kind: Type.Literal("every"), minutes: Type.Number({ minimum: 1, description: "Minutes between occurrences (at least 1), anchored at creation." }) }),
  Type.Object({ kind: Type.Literal("cron"), expression: Type.String({ description: "Five-field cron expression." }), timezone: Type.String({ description: "IANA timezone, e.g. Asia/Shanghai." }) }),
]);
const mutation = { effect: "write", mode: "sequential", resources: () => singletonResource("schedules", "*", "write") } as const;

/** Ordinary agent tools: the host owns durable creation, session binding and wakeup admission. */
export function createScheduleTools(host: ScheduleHost): AgentTool[] {
  const create: AgentTool<{
    name: string; prompt: string; initialPrompt?: string; schedule: ScheduleSpec; target?: "current" | "new";
  }> = {
    name: "schedule_task",
    description: "When the user asks to do something at a future time or repeatedly, use this tool to schedule it rather than promising to remember. " +
      "Schedules wake only while Thread is running; missed intervals are merged, not replayed. " +
      "target=new (default) creates one independent Session reused for all wakeups; it does not inherit this chat. " +
      "Creation queues initialPrompt immediately (defaulting to prompt); it runs as soon as the runtime is idle, after any current turn. " +
      "For new Sessions, make initialPrompt self-contained with task background and instructions for what to do now; prompt is used at the scheduled times. " +
      "If the requested action must wait, use initialPrompt only for preparation, not early execution. " +
      "target=current sends wakeups to this invoking Session. The time rule applies after the initial turn; at still delivers one follow-up at its specified time.",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 200, description: "Recognizable task name." }),
      prompt: Type.String({ minLength: 1, maxLength: 32_000, description: "Instructions for scheduled follow-ups; also run immediately after creation if initialPrompt is omitted." }),
      initialPrompt: Type.Optional(Type.String({ minLength: 1, maxLength: 32_000, description: "Self-contained background and instructions queued immediately at creation, run once when the runtime is idle." })),
      schedule: scheduleSchema,
      target: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("new")], { description: "Current invoking Session, or one new independent Session (default)." })),
    }),
    execution: mutation,
    async execute(args, context) {
      try {
        requireMain(context);
        if (!args.name?.trim() || !args.prompt?.trim() || (args.initialPrompt !== undefined && !args.initialPrompt.trim())) {
          throw new Error("name, prompt, and any initialPrompt must be non-empty");
        }
        if (args.target !== undefined && args.target !== "new" && args.target !== "current") {
          throw new Error("target must be current or new");
        }
        const schedule = normalizeSchedule(args.schedule);
        const sessionId = args.target === "current" ? context.invocation.sessionId : undefined;
        if (args.target === "current" && !sessionId) throw new Error("Current target requires an invoking Session");
        const task = await host.createSchedule({
          name: args.name, prompt: args.prompt, schedule,
          ...(args.initialPrompt !== undefined ? { initialPrompt: args.initialPrompt } : {}),
          ...(sessionId ? { sessionId } : {}),
        }, { signal: context.signal });
        return ok(JSON.stringify({ task, note: "The initial message is queued now and runs once the runtime is idle, after any current turn. Later messages follow the time rule. Thread must remain running; all wakeups reuse the bound Session." }, null, 2), task);
      } catch (error) { return fail(error); }
    },
  };

  const list: AgentTool = {
    name: "list_schedules",
    description: "List scheduled tasks and their bound Sessions, first/follow-up prompts, time rules, enabled state, next time, last run and last error. Only online Thread schedules execute.",
    parameters: Type.Object({}),
    execution: { effect: "read", mode: "parallel", resources: () => singletonResource("schedules", "*", "read") },
    async execute(_args, context) {
      try {
        requireMain(context);
        const tasks = host.listSchedules().map((task) => ({
          ...task,
          nextRunTime: task.nextRunAt === null ? null : new Date(task.nextRunAt).toISOString(),
          lastRun: task.lastRun ?? null,
          lastError: task.lastError ?? null,
        }));
        context.signal.throwIfAborted();
        return ok(JSON.stringify({ tasks }, null, 2), { tasks });
      } catch (error) { return fail(error); }
    },
  };

  const pause: AgentTool<{ id: string }> = {
    name: "pause_schedule",
    description: "Pause future wakeups without deleting the task or stopping an already-running turn. Use list_schedules to find the id.",
    parameters: Type.Object({ id: Type.String() }),
    execution: mutation,
    async execute(args, context) {
      try {
        requireMain(context);
        return ok(JSON.stringify(await host.setScheduleEnabled(args.id, false, { signal: context.signal }), null, 2));
      } catch (error) { return fail(error); }
    },
  };

  const resume: AgentTool<{ id: string }> = {
    name: "resume_schedule",
    description: "Resume a paused task. A pending initial message becomes due immediately. After initialization, recurring tasks restart at their next future occurrence; an unconsumed overdue one-shot follow-up runs once. A consumed one-shot cannot be resumed.",
    parameters: Type.Object({ id: Type.String() }),
    execution: mutation,
    async execute(args, context) {
      try {
        requireMain(context);
        return ok(JSON.stringify(await host.setScheduleEnabled(args.id, true, { signal: context.signal }), null, 2));
      } catch (error) { return fail(error); }
    },
  };

  const remove: AgentTool<{ id: string }> = {
    name: "delete_schedule",
    description: "Delete a scheduled task by its id. Its bound Session and history remain; an already-running turn is not stopped.",
    parameters: Type.Object({ id: Type.String() }),
    execution: mutation,
    async execute(args, context) {
      try {
        requireMain(context);
        await host.deleteSchedule(args.id, { signal: context.signal });
        return ok(`Deleted scheduled task ${args.id}`);
      } catch (error) { return fail(error); }
    },
  };

  return [create, list, pause, resume, remove];
}
