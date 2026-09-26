import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ThreadApp } from "../../app/thread-app.js";
import { parseGoalInput } from "../../app/input-router.js";
import type { SessionGoal } from "../../core/session-tree/model.js";

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
  let active: AbortController | undefined;
  let runningGoal: Promise<void> | undefined;
  const onSigint = () => active?.abort(new Error("Interrupted by user"));
  process.on("SIGINT", onSigint);
  let streamed = false;
  const taskStatuses = new Map<string, string>();
  const detachRuntime = app.runtime.subscribe((event) => {
    if (event.sessionId !== app.selectedSessionId) return;
    if (event.type === "goal_changed" && event.agentId === "main") {
      if (streamed) { output.write("\n"); streamed = false; }
      output.write(goalLine(event.goal ?? undefined));
      return;
    }
    if (event.agentId === "main" && event.type === "turn_finished" && streamed) {
      output.write("\n");
      streamed = false;
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
  const handleLine = async (line: string, controller: AbortController): Promise<void> => {
    const previousSessionId = app.selectedSessionId;
    try {
      const result = await app.handleInput(line, { signal: controller.signal });
      if (streamed) { output.write("\n"); streamed = false; }
      if (result.kind === "command" && result.result.presentation === "clear") {
        output.write(output.isTTY ? "\x1b[2J\x1b[H" : "[display cleared]\n");
      } else if (result.kind === "command") {
        output.write(`\n[thread result]\n${result.result.content}\n`);
      }
      if (app.selectedSessionId !== previousSessionId) {
        const goal = app.runtime.readGoal(app.selectedSessionId);
        if (goal) output.write(goalLine(goal));
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
        line = await readline.question(`\n${app.selectedSessionId.slice(0, 12)}> `);
      } catch {
        break;
      }
      if (line.trim() === "/exit") break;
      if (!line.trim()) continue;
      const action = parseGoalInput(line);
      if (action?.type === "run" || action?.type === "resume") {
        if (runningGoal) { output.write("[error] Wait for the active goal to finish.\n"); continue; }
        const controller = new AbortController();
        active = controller;
        const pending = handleLine(line, controller).finally(() => {
          if (runningGoal === pending) runningGoal = undefined;
          if (active === controller) active = undefined;
        });
        runningGoal = pending;
        // Piped input must finish this goal before consuming another line (or EOF).
        if (!interactive) await pending;
        continue;
      }
      if (runningGoal && action?.type !== "status" && action?.type !== "pause" && action?.type !== "clear") {
        output.write("[error] Wait for the active goal to finish.\n");
        continue;
      }
      const controller = new AbortController();
      if (!runningGoal) active = controller;
      await handleLine(line, controller);
      if (active === controller) active = undefined;
    }
  } finally {
    active?.abort(new Error("Plain CLI closed"));
    await runningGoal;
    detachRuntime();
    process.off("SIGINT", onSigint);
    readline.close();
  }
}
