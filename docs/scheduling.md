# Scheduled tasks

A schedule asks Thread to send an ordinary user turn to a fixed Session at a future time. In the coding app, ask the main agent to create one (for example, “Every morning, check the build and summarize any failures”). The agent can use `schedule_task`; it can also manage tasks with `list_schedules`, `pause_schedule`, `resume_schedule`, and `delete_schedule`. For model-free management, use `/schedule` or `/schedule list`, `/schedule pause <id>`, `/schedule resume <id>`, and `/schedule delete <id>`. In the TUI, the list is a picker: select a task and press Enter to open its bound Session. You can also use `/schedule open <id>` directly, including in plain mode. Creation is done by asking the agent or using the runtime API, not a slash command.

## Sessions and instructions

By default, `schedule_task` uses `target: "new"`: creation makes **one empty Session**, reused for every wakeup. It does not copy the conversation in which the request was made. Give `initialPrompt` all the background, scope, and instructions needed for its first run. The shorter `prompt` is used for later runs; if `initialPrompt` is omitted, `prompt` is used for both. For example:

```text
initialPrompt: "Each morning, inspect the build status in this project. Report failing jobs and their evidence; do not change files. Stop and ask for guidance if the build system is unavailable."
prompt:        "Check the latest build again; report new or remaining failures."
```

To continue **this conversation** instead, ask the main agent to schedule with `target: "current"`. That binds the task to the Session making the tool call, including its existing context. An embedded host uses `sessionId` in `createSchedule()` for the same binding; omit it to create the dedicated Session. The binding never changes. Both wakeup texts are normal `user` messages, retain Session context, and use ordinary compaction. The first text is determined by whether a scheduled turn has been admitted, **not** by whether the Session is otherwise empty. Even if that first turn is interrupted, its user message stays in history and the next wakeup uses `prompt`.

A dedicated Session inherits the application's configured model instructions and tools and shares the project workspace; it does **not** inherit the creator's chat history or provide a sandbox. A background wakeup does not switch the coding app's selected Session.

You can open the bound Session while the task is running, through `/schedule` or the regular `/session` picker. The TUI shows its history and current text, thinking, tools, and workers. It keeps receiving the running turn's events while you view another Session, so switching back retains the live content already received. Viewing a Session does not interrupt or redirect the running agent; starting another agent turn still waits for the project to become idle.

## Times and lifecycle

Choose one time rule: `at` is a future ISO date-time with an explicit `Z` or UTC offset; `every` uses `minutes >= 1` anchored to creation time; `cron` is a five-field expression with an IANA `timezone` (evaluated with Croner). A new task must have a future occurrence. All execution remains serial across the project: if Thread is busy or closed, missed repeated occurrences are merged into one pending wakeup, run when execution becomes available, then advanced to a future time rather than replayed one by one. A one-time task that becomes overdue while Thread is closed runs once after reopening.

Plans persist across restarts, but **nothing fires while the Thread process is stopped**; there is no daemon. Pausing keeps the plan. Resuming a recurring task recalculates its next future occurrence, rather than replaying paused intervals; a one-time task already admitted cannot be resumed. Pausing or deleting does not stop a turn already running—use Esc or `interrupt(sessionId)` to cancel it. Deleting a task leaves its Session and turn history intact.

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
    initialPrompt: "Inspect this project's build status each morning; report failures with evidence. Do not change files.",
    prompt: "Check the latest build and report new or remaining failures.",
    schedule: { kind: "cron", expression: "0 9 * * *", timezone: "Asia/Shanghai" },
    // Omit sessionId for one new dedicated Session; pass an existing ID to bind it instead.
  });
  console.log(task.id, task.sessionId);
  await new Promise<void>((resolve) => process.once("SIGINT", () => resolve()));
} finally {
  clearInterval(keepAlive);
  await runtime.close();
}
```

Use `runtime.listSchedules()`, `runtime.setScheduleEnabled(id, false | true)`, and `runtime.deleteSchedule(id)` for management. `runtime.schedulingEnabled` reports availability; `runtime.busy` and `runtime.activeSessionId` report execution state, with the latter naming only the current execution target, not the UI-selected Session.
