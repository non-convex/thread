#!/usr/bin/env node
import { stdout as output } from "node:process";
import { ThreadApp } from "../app.js";
import { createConfiguredModelCatalog } from "../agent/model-client.js";
import { loadModelConfig } from "../config/model-config.js";
import { loadExtension } from "../extensions/loader.js";
import { runPlainCli } from "../ui/plain/runner.js";
import { ThreadTerminalApp, type TerminalMode } from "../ui/terminal/app.js";
import { discoverGitWorkspace } from "../workspace/discovery.js";

interface CliOptions {
  rootPath: string;
  provider: string | undefined;
  model: string | undefined;
  configPath: string | undefined;
  extensions: string[];
  tui: TerminalMode | "plain";
  help: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    rootPath: process.cwd(),
    provider: process.env.THREAD_PROVIDER,
    model: process.env.THREAD_MODEL,
    configPath: process.env.THREAD_CONFIG,
    extensions: [],
    tui: "fullscreen",
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (["--root", "--provider", "--model", "--config", "--extension", "--tui"].includes(arg)) {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === "--root") options.rootPath = value;
      if (arg === "--provider") options.provider = value;
      if (arg === "--model") options.model = value;
      if (arg === "--config") options.configPath = value;
      if (arg === "--extension") options.extensions.push(value);
      if (arg === "--tui") {
        if (value !== "fullscreen" && value !== "regular" && value !== "plain") {
          throw new Error("--tui requires fullscreen, regular, or plain");
        }
        options.tui = value;
      }
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if ((options.provider && !options.model) || (!options.provider && options.model)) {
    throw new Error("--provider and --model must be supplied together");
  }
  return options;
}

function help(): string {
  return `thread mini harness

Usage: thread [--root <git-worktree>] [--config <file>]
                 [--provider <id> --model <id>] [--extension <module>]
                 [--tui fullscreen|regular|plain]

TTY default: fullscreen TUI. Non-TTY input/output automatically uses plain mode.
Default config: ~/.thread/config.json
Fallback: ~/.pi/agent/models.json + settings.json when thread config is absent
Environment: THREAD_HOME, THREAD_CONFIG, THREAD_PROVIDER, THREAD_MODEL
Inside the prompt use /model to inspect or switch models, /clear, /compact,
/thread for version commands, /rewind <turn-id>, or /exit.`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    output.write(`${help()}\n`);
    return;
  }
  const workspace = await discoverGitWorkspace(options.rootPath);
  const loadedConfig = await loadModelConfig(options.configPath);
  const providerId = options.provider ?? loadedConfig?.config.model?.provider;
  const modelId = options.model ?? loadedConfig?.config.model?.id;
  const modelCatalog = createConfiguredModelCatalog(loadedConfig?.config.providers ?? {});
  const model = providerId && modelId
    ? modelCatalog.createClient(providerId, modelId)
    : undefined;
  const app = await ThreadApp.open({
    rootPath: workspace.rootPath,
    ...(model ? { model } : {}),
    modelCatalog,
  });
  try {
    for (const extension of options.extensions) await loadExtension(extension, app.extensionApi, process.cwd());
    const usePlain = options.tui === "plain" || !process.stdin.isTTY || !process.stdout.isTTY;
    if (usePlain) {
      await runPlainCli(app, {
        ...(loadedConfig ? { configDescription: `${loadedConfig.source} ${loadedConfig.path}` } : {}),
      });
    } else {
      await new ThreadTerminalApp(app, {
        mode: options.tui === "regular" ? "regular" : "fullscreen",
      }).run();
    }
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
