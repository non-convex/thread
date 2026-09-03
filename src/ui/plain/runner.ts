import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ThreadApp } from "../../app.js";

export interface PlainRunnerOptions {
  configDescription?: string;
}

export async function runPlainCli(app: ThreadApp, options: PlainRunnerOptions): Promise<void> {
  const tree = app.sessionTree.tree;
  output.write(
    `Session Tree ${tree.id}\nSession ${app.sessionTree.activeSession.id} @ ${app.sessionTree.activeLiveTip ?? "Root"}\n${
      app.model
        ? `model ${app.model.providerId}/${app.model.modelId}`
        : "no model configured; use /model to select one"
    }${options.configDescription ? `\nconfig ${options.configDescription}` : ""}\n`,
  );
  output.write(`implementation-worker ${app.subagentEnabled ? `on · ${app.subagentModel?.provider}/${app.subagentModel?.id}` : "off · use /agent to configure"}\n`);
  output.write(`dreamer ${app.dreamerEnabled ? `on · ${app.dreamerModel?.provider}/${app.dreamerModel?.id}` : "off · use /agent to configure"}\n`);
  for (const diagnostic of app.agentProfileDiagnostics) {
    output.write(`[agent ${diagnostic.level}] ${diagnostic.profileId}: ${diagnostic.message}\n`);
  }
  const readline = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  let active: AbortController | undefined;
  const onSigint = () => active?.abort(new Error("Interrupted by user"));
  process.on("SIGINT", onSigint);
  try {
    const taskStatuses = new Map<string, string>();
    while (true) {
      let line: string;
      try {
        line = await readline.question(`\n${app.sessionTree.activeSession.id.slice(0, 12)}> `);
      } catch {
        break;
      }
      if (line.trim() === "/exit") break;
      if (!line.trim()) continue;
      active = new AbortController();
      let streamed = false;
      try {
        const result = await app.handleInput(line, {
          signal: active.signal,
          onTextDelta: (delta) => {
            streamed = true;
            output.write(delta);
          },
          onUiEvent: (event) => {
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
          },
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
    process.off("SIGINT", onSigint);
    readline.close();
  }
}
