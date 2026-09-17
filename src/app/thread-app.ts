import path from "node:path";
import type { ModelCatalog } from "../core/agent/model-catalog.js";
import { getThreadHome } from "../core/config/home.js";
import { GLOBAL_MEMORY_FILE } from "../core/global-memory.js";
import { ThreadRuntime } from "../core/runtime/thread-runtime.js";
import { snapshotRuntimeOptions, type ThreadRuntimeOptions } from "../core/runtime/options.js";
import { skillsDirectory } from "../core/skills/loader.js";
import { createAskTool } from "../core/tools/ask.js";
import { fileEditingPrompt } from "../core/tools/file-editing-prompt.js";
import { safeUiEvent } from "../ui/events.js";
import { agentCommand } from "./commands/agents.js";
import { buildRewindItems, registerBuiltinCommands } from "./commands/builtins.js";
import { ThreadCommandRouter } from "./commands/registry.js";
import { CommandRegistry, ephemeral, viewResult, type CommandResult } from "./commands/types.js";
import { createExtensionAPI, type ExtensionAPI } from "./extensions/api.js";
import { loadExtension, type ExtensionDisposer } from "./extensions/loader.js";
import { InputRouter, type InputOptions, type InputResult } from "./input-router.js";
import { loadProjectInstructions } from "./project-instructions.js";
import { DEFAULT_COMMIT_ATTRIBUTION, DEFAULT_SYSTEM_PROMPT, formatCommitAttributionPrompt } from "./system-prompt.js";

export type { InputResult } from "./input-router.js";
/** Product options for the coding application. Other hosts open ThreadRuntime directly. */
export interface ThreadAppOptions extends Omit<ThreadRuntimeOptions, "search" | "globalMemoryPath"> {
  search?: ThreadRuntimeOptions["search"] | false;
  globalMemoryPath?: string | false;
  commitAttribution?: string;
  /** Read rootPath/AGENTS.md once at startup. Default: true. */
  projectInstructions?: boolean;
}

/** Owns coding defaults, selected-session UI state, commands and extensions. */
export class ThreadApp {
  readonly commands = new CommandRegistry();
  readonly extensionApi: ExtensionAPI;
  selectedSessionId: string;
  private readonly commandRouter = new ThreadCommandRouter(this.commands);
  private readonly inputRouter: InputRouter;
  private inputOperation: { controller: AbortController; done: Promise<InputResult> } | undefined;
  private readonly extensionDisposers: ExtensionDisposer[] = [];
  private extensionLoading: Promise<void> = Promise.resolve();
  private appClosing: Promise<void> | undefined;

  private constructor(readonly runtime: ThreadRuntime, catalog: ModelCatalog | undefined, skillPaths: readonly string[]) {
    this.selectedSessionId = runtime.initialSessionId;
    registerBuiltinCommands(this.commands);
    this.extensionApi = createExtensionAPI(runtime, this.commands);
    const paths = skillPaths.map((directory) => path.resolve(runtime.rootPath, directory));
    this.inputRouter = new InputRouter({
      newSession: (options) => this.runCommand("new", options, async () => {
        const session = await runtime.createSession(options);
        this.selectedSessionId = session.id;
        safeUiEvent(options.onUiEvent, { type: "session_changed", sessionId: session.id, liveTipTurnId: null, reason: "new" });
        const warnings = runtime.agentProfileDiagnostics.filter((item) => item.profileId === "main").map((item) => `Warning: ${item.message}`);
        return ephemeral([`Created empty Session ${session.id} from Root; workspace unchanged`, ...warnings].join("\n"), true);
      }),
      agent: async (args) => ({ kind: "command", result: agentCommand(runtime, catalog, args) }),
      model: async (args) => ({ kind: "command", result: agentCommand(runtime, catalog, ["main", "model", ...args]) }),
      skill: async (name, extra, options) => {
        if (!name) {
          const content = [
            ...paths.map((directory) => `Skills directory: ${directory}`),
            runtime.skills.length ? `Loaded skills: ${runtime.skills.length}` : "No skills loaded for this application.",
            ...runtime.skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.filePath})`),
            ...runtime.skillDiagnostics.map((item) => `${item.kind}: ${item.message} (${item.path})`),
          ].join("\n");
          return { kind: "command", result: viewResult(content, {
            type: "command_picker", title: "Skills",
            items: runtime.skills.map((skill) => ({ label: skill.name, description: skill.description, command: `/skill ${skill.name} `, submit: false })),
            emptyText: paths.length ? `No skills loaded. Add skills under ${paths.join(", ")}` : "No skills loaded for this application.",
          }) };
        }
        if (!runtime.model) throw new Error("/skill requires a configured model");
        return { kind: "turn", result: await runtime.invokeSkill(this.selectedSessionId, name, extra, options) };
      },
      compact: (options) => {
        if (!runtime.model) throw new Error("/compact requires a configured model");
        return this.runCommand("compact", options, async () => {
          const result = await runtime.compact(this.selectedSessionId, options);
          return ephemeral(result.compacted
            ? `Context compacted: ${result.summarizedSteps} step(s) summarized; ${result.retainedSteps} retained; ${result.tokensBefore - result.tokensAfter} estimated tokens freed`
            : "Nothing can be compacted with a meaningful estimated token reduction", result.compacted);
        });
      },
      session: (args, options) => this.routeThreadCommand(args.length ? `/thread open ${args.join(" ")}` : "/thread sessions", options),
      rewind: async (args, options) => {
        if (args.length > 1) throw new Error("Usage: /rewind [turn-id-or-user-entry-id]");
        if (!args.length) {
          const items = buildRewindItems(this.commandContext(options.signal));
          return { kind: "command", result: items.length
            ? viewResult(runtime.fileCheckpoints
              ? "Choose a current-path user message. Rewind restores recorded edit/write changes; bash changes are not tracked. Later changes to recorded files are overwritten."
              : "Choose a current-path user message. Rewind changes the conversation context and leaves workspace files unchanged.", { type: "rewind", items })
            : ephemeral("(no user turns on the current live path)") };
        }
        const candidate = await runtime.rewind(this.selectedSessionId, args[0]!, options);
        safeUiEvent(options.onUiEvent, { type: "session_changed", sessionId: this.selectedSessionId,
          liveTipTurnId: runtime.readSession(this.selectedSessionId).liveTipTurnId, reason: "rewind" });
        return { kind: "command", result: ephemeral(`Rewound to before ${candidate.turnId}; prior path retained`, true) };
      },
      thread: (input, options) => this.routeThreadCommand(input, options),
      turn: async (input, options) => {
        if (!runtime.model) throw new Error("No model configured. Use /model list and /model <provider>/<model>.");
        if (options.images?.length && runtime.model.acceptsImages !== true) {
          throw new Error("Current model does not accept images. Use /model to pick a vision model.");
        }
        return { kind: "turn", result: await runtime.prompt(this.selectedSessionId, input, options) };
      },
    });
  }

  static async open(options: ThreadAppOptions): Promise<ThreadApp> {
    const { search, globalMemoryPath, commitAttribution, projectInstructions = true, ...core } = options;
    const skills = core.skills ?? { paths: [skillsDirectory()] };
    const paths = "paths" in skills ? [...skills.paths] : [];
    const tools = core.tools ?? ["read", "list", "grep", "write", "edit", "bash", "websearch", "webfetch"];
    const needsAskTool = !core.askPresenter && !tools.some((tool) => typeof tool !== "string" && tool.name === "ask");
    const fileCheckpoints = core.fileCheckpoints ?? true;
    const runtimeOptions = snapshotRuntimeOptions({
      ...core, tools, skills, fileCheckpoints,
      systemPrompt: [core.systemPrompt ?? DEFAULT_SYSTEM_PROMPT, fileEditingPrompt(fileCheckpoints),
        formatCommitAttributionPrompt(commitAttribution ?? DEFAULT_COMMIT_ATTRIBUTION)].filter(Boolean).join("\n\n"),
      ...(search === false ? {} : { search: search ?? {} }),
      ...(globalMemoryPath === false ? {} : { globalMemoryPath: globalMemoryPath ?? path.join(getThreadHome(), GLOBAL_MEMORY_FILE) }),
    });
    if (projectInstructions) {
      const projectText = await loadProjectInstructions(runtimeOptions.rootPath);
      runtimeOptions.sharedInstructions = [runtimeOptions.sharedInstructions, projectText].filter(Boolean).join("\n\n");
    }
    const runtime = await ThreadRuntime.open(runtimeOptions);
    try {
      // Plain mode retains the coding agent's ask contract and its unavailable response.
      if (needsAskTool) runtime.registerTool(createAskTool());
      return new ThreadApp(runtime, core.modelCatalog, paths);
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }

  async loadExtension(specifier: string): Promise<void> {
    this.assertOpen();
    const loading = this.extensionLoading.then(async () => {
      const dispose = await loadExtension(specifier, this.extensionApi, this.runtime.rootPath);
      if (dispose) this.extensionDisposers.push(dispose);
    });
    this.extensionLoading = loading.catch(() => undefined);
    return loading;
  }

  async openSession(sessionId: string, options: { signal?: AbortSignal } = {}) {
    this.assertOpen();
    const session = await this.runtime.openSession(sessionId, options);
    this.selectedSessionId = session.id;
    return session;
  }

  handleInput(input: string, options: InputOptions): Promise<InputResult> {
    try { this.assertOpen(); } catch (error) { return Promise.reject(error); }
    if (this.inputOperation) return Promise.reject(new Error("Wait for the active turn or command to finish"));
    const controller = new AbortController();
    const signal = AbortSignal.any([options.signal, controller.signal]);
    const done = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return this.inputRouter.route(input, { ...options, signal });
    }).finally(() => {
      if (this.inputOperation?.controller === controller) this.inputOperation = undefined;
    });
    this.inputOperation = { controller, done };
    void done.catch(() => undefined);
    return done;
  }

  private async runCommand(name: string, options: InputOptions, execute: () => Promise<CommandResult>): Promise<InputResult> {
    safeUiEvent(options.onUiEvent, { type: "command_started", name });
    let ok = false;
    try {
      const result = await execute();
      ok = true;
      return { kind: "command", result };
    } finally {
      safeUiEvent(options.onUiEvent, { type: "command_finished", name, ok });
    }
  }

  private commandContext(signal: AbortSignal) {
    return { rootPath: this.runtime.rootPath, runtime: this.runtime, selectedSessionId: this.selectedSessionId,
      skills: this.runtime.skills, skillDiagnostics: this.runtime.skillDiagnostics, signal,
      openSession: (id: string) => this.openSession(id, { signal }) };
  }

  private async routeThreadCommand(input: string, options: { signal: AbortSignal }): Promise<InputResult> {
    const result = await this.commandRouter.route(input, this.commandContext(options.signal));
    if (!result) throw new Error(`Could not route command: ${input}`);
    return { kind: "command", result };
  }

  private assertOpen(): void {
    if (this.appClosing) throw new Error("Thread application is closed or closing");
  }

  close(): Promise<void> {
    if (this.appClosing) return this.appClosing;
    const input = this.inputOperation;
    this.appClosing = Promise.resolve().then(async () => {
      await input?.done.catch(() => undefined);
      await this.extensionLoading;
      try {
        await this.runtime.close();
      } finally {
        await Promise.allSettled(this.extensionDisposers.splice(0).map((dispose) => Promise.resolve().then(dispose)));
      }
    });
    input?.controller.abort(new DOMException("Thread application closed", "AbortError"));
    return this.appClosing;
  }
}
