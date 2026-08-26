import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ThreadApp } from "../../app.js";

export interface PlainRunnerOptions {
  configDescription?: string;
}

export async function runPlainCli(app: ThreadApp, options: PlainRunnerOptions): Promise<void> {
  const status = app.versions.status();
  output.write(
    `Session Tree ${status.sessionId}\nthread branch ${status.currentBranch} @ ${status.headCheckpointId}\n${
      app.model
        ? `model ${app.model.providerId}/${app.model.modelId}`
        : "no model configured; use /model to select one or /thread for version commands"
    }${options.configDescription ? `\nconfig ${options.configDescription}` : ""}\n`,
  );
  const readline = createInterface({ input, output, terminal: Boolean(input.isTTY && output.isTTY) });
  let active: AbortController | undefined;
  const onSigint = () => active?.abort(new Error("Interrupted by user"));
  process.on("SIGINT", onSigint);
  try {
    while (true) {
      let line: string;
      try {
        line = await readline.question(`\n${app.versions.currentBranch.name}> `);
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
        });
        if (streamed) output.write("\n");
        if (result.kind === "command" && result.result.presentation === "clear") {
          output.write(output.isTTY ? "\x1b[2J\x1b[H" : "[display cleared]\n");
        } else if (result.kind === "command") {
          output.write(`\n[thread version result]\n${result.result.content}\n`);
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
