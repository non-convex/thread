# Scheduled tasks

A schedule asks Thread to initialize a task in a fixed Session immediately, then send ordinary user turns at the configured times. In the coding app, ask the main agent to create one (for example, “Every morning, check the build and summarize any failures”). The agent can use `schedule_task`; it can also manage tasks with `list_schedules`, `update_schedule`, `pause_schedule`, `resume_schedule`, and `delete_schedule`. For model-free management, use `/schedule` or `/schedule list`, `/schedule pause <id>`, `/schedule resume <id>`, and `/schedule delete <id>`; there is no CLI edit subcommand. In the TUI, the list is a picker: select a task and press Enter to open its bound Session. You can also use `/schedule open <id>` directly, including in plain mode. Creation is done by asking the agent or using the runtime API, not a slash command.

## Sessions and instructions

By default, `schedule_task` uses `target: "new"`: creation makes **one independent Session**, reused for every wakeup. It does not copy the conversation in which the request was made. Creation queues `initialPrompt` immediately instead of waiting for the first scheduled time. Give it all the background, scope, ongoing instructions, and what the agent should do now. The Session retains context across wakeups, so `prompt` should be only a brief cue such as “Wake up and continue.” Do not repeat the setup, rules, or checklists in each follow-up. If `initialPrompt` is omitted, `prompt` runs both immediately and at the configured times.

The first message includes the task's full scheduling context. Later messages contain only a short scheduled-wakeup label, the task name, and `prompt`. Task IDs, timestamps, time rules, and permission reminders are not repeated in the message body. Timing and wakeup provenance remain in the task and turn records.

The runtime executes one operation per Session at a time. Initialization in the current Session waits for its turn to finish; a task in another idle Session can start on the scheduler's next scan (normally within one second). Creation does not wait for the initial model response. The message appears in the Session history when execution starts, so the Session can still appear empty while waiting for admission or a configured model.

If an action must wait until a future time, make the initial instructions preparation-only. For example:

```text
initialPrompt: "You will inspect the build status each morning. Now identify the build service and access requirements, without running the scheduled check. Later, report failing jobs and their evidence; do not change files. Ask for guidance if the build system is unavailable."
prompt:        "Time for the build check."
```

To continue **this conversation** instead, ask the main agent to schedule with `target: "current"`. That binds the task to the Session making the tool call, including its existing context. An embedded host uses `sessionId` in `createSchedule()` for the same binding; omit it to create the dedicated Session. The binding never changes. Both wakeup texts are normal `user` messages, retain Session context, and use ordinary compaction. The first text is determined by whether a scheduled turn has been admitted, **not** by whether the Session is otherwise empty. Even if that first turn is interrupted, its user message stays in history and the next wakeup uses `prompt`.

A dedicated Session inherits the application's configured model instructions and tools and shares the project workspace; it does **not** inherit the creator's chat history or provide a sandbox. A background wakeup does not switch the coding app's selected Session.

To update future wakeups, the agent can call `update_schedule({ id, prompt?, schedule? })`. Supply at least one of `prompt` or `schedule`; both can change in the same update. The `id` accepts an existing task ID or a unique prefix. A supplied `prompt` must be nonempty and at most 32,000 characters; keep it brief and rely on the bound Session's context instead of repeating the setup.

For example, change an hourly task to every 50 minutes without losing its Session:

```json
{
  "id": "<existing-task-id>",
  "schedule": { "kind": "every", "minutes": 50 }
}
```

Updates preserve the task ID, bound Session and history, `initialPrompt`, creation time, enabled state, and last run/error. A prompt-only update also preserves the time rule and `nextRunAt`.

Providing `schedule` requires a future occurrence, using the same validation as creation. Once initialization has started, the update replaces `nextRunAt` with the new rule's next occurrence strictly after the update. The previous pending follow-up is replaced, not replayed. `every` stays anchored to the original creation time: if a task was created at 10:00 and changed to every 50 minutes at 10:25, its next follow-up is at 10:50, not 11:15. If initialization has not started, its existing pending slot remains unchanged; the new rule applies to the follow-ups. Updating never queues another initial message.

Paused or completed tasks remain disabled. To use a completed one-shot again, give it a new future time rule and then resume it. Merely changing its prompt does not make its consumed occurrence available again.

Updates are allowed during execution. Already-running turns are not interrupted, and messages already prepared retain their text. If a time-rule update replaces a follow-up that was prepared but not yet admitted, admission rejects the obsolete occurrence; the scheduler uses the new time instead.

You can open the bound Session while the task is running, through `/schedule` or the regular `/session` picker. The TUI shows its history and current text, thinking, tools, and workers. It keeps receiving the running turn's events while you view another Session, so switching back retains the live content already received. Viewing a Session does not interrupt or redirect the running agent; starting another agent turn still waits for the project to become idle.

## Times and lifecycle

Choose one follow-up time rule: `at` is a future ISO date-time with an explicit `Z` or UTC offset; `every` uses `minutes >= 1` anchored to creation time; `cron` is a five-field expression with an IANA `timezone` (evaluated with Croner). A new task must have a future occurrence. Initialization is additional to this rule: an `at` task runs its initial instructions now and its follow-up once at the specified time.

Execution is serial within each Session; different Sessions can run concurrently in the shared project workspace. A delayed initial message remains pending until its Session becomes available, without blocking tasks in other Sessions. After initialization, recurring tasks advance to the next future occurrence without replaying intervals missed before initialization; an overdue `at` follow-up stays due and runs next. Later missed repeated occurrences are merged into one pending wakeup, run when execution becomes available, then advanced to a future time rather than replayed one by one. A one-time task that becomes overdue while Thread is closed runs once after reopening.

Plans persist across restarts, but **nothing fires while the Thread process is stopped**; there is no daemon. Pausing keeps the plan. If initialization has not started, resuming makes it due immediately. Otherwise, resuming a recurring task recalculates its next future occurrence, rather than replaying paused intervals. An `at` task can resume after initialization until its scheduled follow-up has been admitted; an overdue, unconsumed follow-up runs once. After that occurrence is consumed, resuming requires a time-rule update with a future occurrence. Pausing or deleting does not stop a turn already running—use Esc or `interrupt(sessionId)` to cancel it. Deleting a task leaves its Session and turn history intact.

A wakeup's user message, its consumed occurrence, and `Turn.scheduled` provenance (`scheduleId`, `scheduledAt`, `phase`) are recorded together when a turn starts. Rewind does not undo plans or replay consumed wakeups. After a crash, unfinished turns are sealed as interrupted under normal recovery rules, not retried for side effects. Scheduling does not guarantee exactly-once **completion**.

## Embedded host

Bare `ThreadRuntime` has scheduling off by default; `ThreadApp` has it on by default. A headless host opts in and keeps the runtime open for as long as it wants wakeups to run. The scheduler uses an unreferenced timer, so the host must also keep its process alive—for example with its existing server or input loop. This small example uses an explicit host-owned timer:

```ts
import { ThreadRuntime } from "thread/runtime";

// model is the host's ModelClient; rootPath points to an existing project.
const runtime = await ThreadRuntime.open({ rootPath, model, tools: ["read", "bash"], scheduling: true });
const keepAlive = setInterval(() => {}, 60_000);
try {
  const task = await runtime.createSchedule({
    name: "Build check",
    initialPrompt: "Prepare for this project's morning build checks: identify the build service and access requirements, without running a check yet. Later report failures with evidence. Do not change files.",
    prompt: "Time for the build check.",
    schedule: { kind: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" },
    // Omit sessionId for one new dedicated Session; pass an existing ID to bind it instead.
  });
  console.log(task.id, task.sessionId);
  // Replace text and timing together; the preparation and Session context remain intact.
  await runtime.updateSchedule(task.id, {
    prompt: "Wake up and continue.",
    schedule: { kind: "every", minutes: 50 },
  });
  await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
} finally {
  clearInterval(keepAlive);
  await runtime.close();
}
```

Use `runtime.listSchedules()`, `runtime.updateSchedule(id, { prompt?, schedule? }, { signal? })`, `runtime.setScheduleEnabled(id, false | true)`, and `runtime.deleteSchedule(id)` for management. `UpdateScheduleInput` accepts `prompt?: string` and `schedule?: ScheduleSpec`; at least one must be supplied, and an empty update is rejected. The optional third argument accepts an `AbortSignal` as `signal`. `runtime.schedulingEnabled` reports availability; `runtime.busy`, `runtime.activeSessionIds` and `runtime.sessionBusy(sessionId)` report aggregate activity, execution targets and admission state for a particular Session, independently of the UI-selected Session.
