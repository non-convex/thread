import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ThreadApp } from "../../app/thread-app.js";
import { parseInput, type RoutedInput } from "../../app/input-router.js";
import type { SessionGoal } from "../../core/session-tree/model.js";
import { projectTranscript } from "../terminal/transcript-projection.js";

function goalLine(goal: SessionGoal | undefined): string {
  return goal ? `[goal ${goal.status} · ${goal.turnsUsed}/${goal.turnLimit} turns] ${goal.objective}${goal.reason ? `\n  reason: ${goal.reason}` : ""}\n`
    : "[goal cleared]\n";
}

export interface PlainRunnerOptions {
  configDescription?: string;
}

export async function runPlainCli(app: ThreadApp, options: PlainRunnerOptions): Promise<void> {
  const session = app.runtime.readSession(app.selectedSessionId);
  output.write(
    `Session Tree ${app.runtime.treeId}\nSession ${session.session.id} @ ${session.liveTipTurnId ?? "Root"}\n${
      app.runtime.model
        ? `model ${app.runtime.model.providerId}/${app.runtime.model.modelId}`
        : "no model configured; use /model to select one"
    }${options.configDescription ? `\nconfig ${options.configDescription}` : ""}\n`,
  );
  output.write(`worker ${app.runtime.workerEnabled ? `on · ${app.runtime.workerModel?.provider}/${app.runtime.workerModel?.id}` : "off · use /agent to configure"}\n`);
  output.write(`dreamer ${app.runtime.dreamerEnabled ? `on · ${app.runtime.dreamerModel?.provider}/${app.runtime.dreamerModel?.id}` : "off · use /agent to configure"}\n`);
  const initialGoal = app.runtime.readGoal(app.selectedSessionId);
  if (initialGoal) output.write(goalLine(initialGoal));
  for (const diagnostic of app.runtime.agentProfileDiagnostics) {
    output.write(`[agent ${diagnostic.level}] ${diagnostic.profileId}: ${diagnostic.message}\n`);
  }
  const interactive = Boolean(input.isTTY && output.isTTY);
  const readline = createInterface({ input, output, terminal: interactive });
  // Keep piped lines queued while an earlier operation is running.
  const lines = interactive ? undefined : readline[Symbol.asyncIterator]();
  let active: AbortController | undefined;
  const pending = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  let explicitExit = false;
  const onSigint = () => {
    const target = app.runtime.activeSessionId;
    if (target) void app.runtime.interrupt(target).catch(() => undefined);
    else active?.abort(new Error("Interrupted by user"));
  };
  process.on("SIGINT", onSigint);
  let streamed = false;
  // Keep only the current execution's received text for opening its Session mid-turn.
  let runningSessionId = app.runtime.activeSessionId;
  let runningText = "";
  const recoverRunningText = (sessionId: string) => {
    const running = app.runtime.readSession(sessionId).activeTurn;
    return running ? projectTranscript(running.entries, running.tasks)
      .filter((item) => item.kind === "assistant").map((item) => item.content).join("\n") : "";
  };
  if (runningSessionId) runningText = recoverRunningText(runningSessionId);
  const taskStatuses = new Map<string, string>();
  const scheduledTurns = new Set<string>();
  const detachRuntime = app.runtime.subscribe((event) => {
    if (event.type === "runtime_status") {
      if (event.busy && event.sessionId) {
        runningSessionId = event.sessionId;
        runningText = recoverRunningText(event.sessionId);
      } else if (!event.busy) {
        runningSessionId = undefined;
        runningText = "";
      }
      return;
    }
    if (event.agentId === "main" && event.type === "assistant_text_delta" && event.sessionId === runningSessionId) {
      runningText += event.delta;
    }
    if (event.agentId === "main" && event.type === "turn_preparing" && event.scheduled) {
      if (streamed) { output.write("\n"); streamed = false; }
      output.write(event.sessionId === app.selectedSessionId
        ? `\n[scheduled ${event.scheduled.phase} wakeup · ${event.scheduled.scheduleId}]\n${event.input}\n`
        : `\n[scheduled ${event.scheduled.phase} wakeup · ${event.scheduled.scheduleId} · Session ${event.sessionId}]\n`);
    }
    if (event.agentId === "main" && event.type === "turn_started" && event.scheduled) scheduledTurns.add(event.turnId);
    const scheduledFinished = event.agentId === "main" && event.type === "turn_finished" && event.turnId
      ? scheduledTurns.delete(event.turnId) : false;
    if (scheduledFinished && event.sessionId !== app.selectedSessionId && event.type === "turn_finished") {
      output.write(`\n[scheduled turn ${event.outcome} · Session ${event.sessionId}]\n`);
    }
    if (event.sessionId !== app.selectedSessionId) return;
    if (event.type === "goal_changed" && event.agentId === "main") {
      if (streamed) { output.write("\n"); streamed = false; }
      output.write(goalLine(event.goal ?? undefined));
      return;
    }
    if (event.agentId === "main" && event.type === "turn_finished") {
      if (streamed) { output.write("\n"); streamed = false; }
      if (scheduledFinished) output.write(`[scheduled turn ${event.outcome}${event.error ? `: ${event.error}` : ""}]\n`);
      return;
    }
    if (event.type === "assistant_text_delta" && event.agentId === "main") {
      streamed = true;
      output.write(event.delta);
      return;
    }
    if (event.type === "agent_task_created") {
      taskStatuses.set(event.summary.taskId, event.summary.status);
      output.write(`\n[worker started] ${event.summary.taskId} ${event.summary.title} · ${event.summary.providerId}/${event.summary.modelId}\n`);
      return;
    }
    if (event.type !== "agent_task_updated") return;
    const previous = taskStatuses.get(event.summary.taskId);
    if (previous === event.summary.status) return;
    taskStatuses.set(event.summary.taskId, event.summary.status);
    const label = event.summary.status === "completed" ? "worker completed"
      : event.summary.status === "running" && event.summary.revision > 0 ? "worker revision"
      : event.summary.status === "failed" ? "worker failed"
      : event.summary.status === "cancelled" ? "worker cancelled"
      : undefined;
    if (label) output.write(`\n[${label}] ${event.summary.taskId} ${event.summary.title}\n`);
  });
  const handleLine = async (route: RoutedInput, controller: AbortController): Promise<void> => {
    const previousSessionId = app.selectedSessionId;
    try {
      const result = await app.handleInput(route, { signal: controller.signal });
      if (streamed) { output.write("\n"); streamed = false; }
      if (result.kind === "command" && result.result.presentation === "clear") {
        output.write(output.isTTY ? "\x1b[2J\x1b[H" : "[display cleared]\n");
      } else if (result.kind === "command") {
        output.write(`\n[thread result]\n${result.result.content}\n`);
      }
      if (app.selectedSessionId !== previousSessionId) {
        const goal = app.runtime.readGoal(app.selectedSessionId);
        if (goal) output.write(goalLine(goal));
        if (app.selectedSessionId === runningSessionId) {
          output.write(`\n[running Session ${runningSessionId} · received so far]\n${runningText || "(waiting for output)"}\n`);
        }
      }
      if (result.kind === "turn" && result.result.error) {
        output.write(`[turn ${result.result.outcome}: ${result.result.error.message}]\n`);
      }
    } catch (error) {
      if (streamed) { output.write("\n"); streamed = false; }
      output.write(`[error] ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  try {
    while (true) {
      let line: string;
      try {
        if (lines) {
          const next = await lines.next();
          if (next.done) break;
          line = next.value;
        } else {
          line = await readline.question(`\n${app.selectedSessionId.slice(0, 12)}> `);
        }
      } catch {
        break;
      }
      if (line.trim() === "/exit") { explicitExit = true; break; }
      if (!line.trim()) continue;
      const route = parseInput(line);
      if (!app.canHandleInput(route)) {
        output.write("[error] Wait for the active turn or command to finish.\n");
        continue;
      }
      const controller = new AbortController();
      controllers.add(controller);
      if (!active) active = controller;
      const operation = handleLine(route, controller).finally(() => {
        controllers.delete(controller);
        pending.delete(operation);
        if (active === controller) active = undefined;
      });
      pending.add(operation);
      // Interactive input stays available for control commands during any work input.
      // Piped input consumes lines in order and waits for the final operation at EOF.
      if (!interactive || route.category === "control") await operation;
    }
  } finally {
    if (explicitExit) for (const controller of controllers) controller.abort(new Error("Plain CLI closed"));
    await Promise.allSettled([...pending]);
    detachRuntime();
    process.off("SIGINT", onSigint);
    readline.close();
  }
}
