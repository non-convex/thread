import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ThreadApp } from "../../app/thread-app.js";

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
  for (const diagnostic of app.runtime.agentProfileDiagnostics) {
    output.write(`[agent ${diagnostic.level}] ${diagnostic.profileId}: ${diagnostic.message}\n`);
  }
  const readline = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  let active: AbortController | undefined;
  const onSigint = () => active?.abort(new Error("Interrupted by user"));
  process.on("SIGINT", onSigint);
  let streamed = false;
  const taskStatuses = new Map<string, string>();
  const detachRuntime = app.runtime.subscribe((event) => {
    if (event.sessionId !== app.selectedSessionId) return;
    if (event.type === "assistant_text_delta") {
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
      active = new AbortController();
      streamed = false;
      try {
        const result = await app.handleInput(line, {
          signal: active.signal,
        });
        if (streamed) output.write("\n");
        if (result.kind === "command" && result.result.presentation === "clear") {
          output.write(output.isTTY ? "\x1b[2J\x1b[H" : "[display cleared]\n");
        } else if (result.kind === "command") {
          output.write(`\n[thread result]\n${result.result.content}\n`);
        }
        if (result.kind === "turn" && result.result.error) {
          output.write(`[turn ${result.result.outcome}: ${result.result.error.message}]\n`);
        }
      } catch (error) {
        if (streamed) output.write("\n");
        output.write(`[error] ${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        active = undefined;
      }
    }
  } finally {
    detachRuntime();
    process.off("SIGINT", onSigint);
    readline.close();
  }
}
