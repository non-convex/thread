#!/usr/bin/env bun
import { stdout as output } from "node:process";
import { ThreadApp } from "../app.js";
import { createConfiguredModelCatalog } from "../agent/model-client.js";
import { ThreadCredentialStore } from "../auth/credential-store.js";
import { loadModelConfig } from "../config/model-config.js";
import { loadModelState, resolveModelSelection, saveModelState } from "../config/model-state.js";
import { loadExtension } from "../extensions/loader.js";
import { runPlainCli } from "../ui/plain/runner.js";
import type { TerminalMode } from "../ui/terminal/app.js";
import { loginProvider, logoutProvider, showAuthStatus } from "./subscription-auth.js";

interface CliOptions {
  rootPath: string;
  provider: string | undefined;
  model: string | undefined;
  configPath: string | undefined;
  extensions: string[];
  tui: TerminalMode | "plain";
  help: boolean;
}

type CliCommand =
  | { type: "login"; providerId: string }
  | { type: "logout"; providerId: string }
  | { type: "auth_status" };

function parseCommand(argv: string[]): CliCommand | undefined {
  if (argv[0] === "login") {
    if (argv.length !== 2 || !argv[1]) throw new Error("Usage: thread login <provider>");
    return { type: "login", providerId: argv[1] };
  }
  if (argv[0] === "logout") {
    if (argv.length !== 2 || !argv[1]) throw new Error("Usage: thread logout <provider>");
    return { type: "logout", providerId: argv[1] };
  }
  if (argv[0] === "auth") {
    if (argv.length !== 2 || argv[1] !== "status") throw new Error("Usage: thread auth status");
    return { type: "auth_status" };
  }
  return undefined;
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
        if (value === "plain") options.tui = "plain";
        else if (value === "fullscreen" || value === "hybrid" || value === "regular") options.tui = "fullscreen";
        else throw new Error("--tui requires fullscreen or plain");
      }
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if ((options.provider && !options.model) || (!options.provider && options.model)) {
    throw new Error("--provider and --model must be supplied together");
  }
  return options;
}

function help(): string {
  return `thread — a session-tree coding agent

Usage: thread [--root <project-directory>] [--config <file>]
                 [--provider <id> --model <id>] [--extension <module>]
                 [--tui fullscreen|plain]
       thread login <provider>
       thread logout <provider>
       thread auth status

TTY default: full-screen OpenTUI. Non-TTY input/output automatically uses plain mode.
Default config: ~/.thread/config.json
Remembered model/thinking choice: ~/.thread/state.json (delete to reset)
Subscription credentials: ~/.thread/auth.json
Fallback: ~/.pi/agent/models.json + settings.json when thread config is absent
Environment: THREAD_HOME, THREAD_CONFIG, THREAD_PROVIDER, THREAD_MODEL
Inside the prompt use /new to create an empty root Session, /session to resume one,
/clear, /compact, /thread for Session Tree history/search, /rewind <turn-id>, or /exit.
In the interactive TUI, Shift+Tab cycles supported thinking levels.`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = parseCommand(argv);
  const credentials = new ThreadCredentialStore();
  if (command) {
    const enabledProviderIds = (await credentials.list()).map((credential) => credential.providerId);
    const catalog = createConfiguredModelCatalog({}, { credentials, enabledProviderIds });
    if (command.type === "login") await loginProvider(catalog, command.providerId);
    else if (command.type === "logout") {
      await logoutProvider(catalog, command.providerId);
      const remembered = await loadModelState();
      if (remembered?.model?.provider === command.providerId) {
        await saveModelState({
          ...(remembered.thinkingLevel ? { thinkingLevel: remembered.thinkingLevel } : {}),
        });
      }
    }
    else await showAuthStatus(catalog);
    return;
  }
  const options = parseArgs(argv);
  if (options.help) {
    output.write(`${help()}\n`);
    return;
  }
  const usePlain = options.tui === "plain" || !process.stdin.isTTY || !process.stdout.isTTY;
  // On Bun/Windows the Solid source transform can receive a corrupted virtual
  // filename when its first TSX import happens after replaying a large JSONL
  // session. Load the TUI module before opening the durable session instead.
  const terminalModule = usePlain ? undefined : await import("../ui/terminal/app.js");
  const loadedConfig = await loadModelConfig(options.configPath);
  const enabledProviderIds = (await credentials.list()).map((credential) => credential.providerId);
  const modelCatalog = createConfiguredModelCatalog(loadedConfig?.config.providers ?? {}, {
    credentials,
    enabledProviderIds,
  });
  // An explicit --provider/--model pair outranks the remembered choice, which in
  // turn outranks the configured default. parseArgs already guarantees the CLI
  // pair is either complete or absent.
  const selection = resolveModelSelection({
    ...(options.provider && options.model ? { cli: { provider: options.provider, id: options.model } } : {}),
    state: await loadModelState(),
    ...(loadedConfig ? { config: loadedConfig.config } : {}),
  });
  let model: ReturnType<typeof modelCatalog.createClient> | undefined;
  if (selection.model) {
    try {
      model = modelCatalog.createClient(selection.model.provider, selection.model.id);
    } catch (error) {
      // A remembered model can disappear when the config changes. Fall back to
      // the configured default instead of refusing to start.
      const configured = loadedConfig?.config.model;
      const canFallBack = configured
        && (configured.provider !== selection.model.provider || configured.id !== selection.model.id);
      if (!canFallBack) throw error;
      output.write(
        `Remembered model ${selection.model.provider}/${selection.model.id} is unavailable; ` +
        `falling back to ${configured!.provider}/${configured!.id}\n`,
      );
      model = modelCatalog.createClient(configured!.provider, configured!.id);
    }
  }
  const app = await ThreadApp.open({
    rootPath: options.rootPath,
    ...(model ? { model } : {}),
    modelCatalog,
    ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
    ...(loadedConfig?.config.cacheRetention
      ? { cacheRetention: loadedConfig.config.cacheRetention }
      : {}),
    onModelStateChange: (state) => {
      // Fire-and-forget: losing a remembered preference must never interrupt
      // the session, so a failed write is silently ignored.
      void saveModelState(state).catch(() => undefined);
    },
  });
  try {
    for (const extension of options.extensions) await loadExtension(extension, app.extensionApi, process.cwd());
    if (usePlain) {
      await runPlainCli(app, {
        ...(loadedConfig ? { configDescription: `${loadedConfig.source} ${loadedConfig.path}` } : {}),
      });
    } else {
      if (!terminalModule) throw new Error("Interactive terminal module was not loaded");
      await new terminalModule.ThreadTerminalApp(app, { mode: "fullscreen" }).run();
    }
  } finally {
    await app.close();
  }
}

function formatCliError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const headline = `${error.name}: ${error.message}`;
  if (!error.stack) return headline;
  return error.message && !error.stack.includes(error.message)
    ? `${headline}\n${error.stack}`
    : error.stack;
}

main().catch((error) => {
  process.stderr.write(`${formatCliError(error)}\n`);
  process.exitCode = 1;
});
