import path from "node:path";
import type { ModelDescriptor, ModelCatalog } from "../core/agent/model-client.js";
import { MAIN_AGENT_PROFILE_ID } from "../core/agent/profile.js";
import { WORKER_PROFILE_ID } from "../core/agent-task/profile.js";
import { DREAMER_PROFILE_ID } from "../core/dreamer/profile.js";
import { buildRewindItems, registerBuiltinCommands } from "./commands/builtins.js";
import { ThreadCommandRouter } from "./commands/registry.js";
import { CommandRegistry, ephemeral, viewResult, type CommandResult } from "./commands/types.js";
import { createExtensionAPI, type ExtensionAPI } from "./extensions/api.js";
import { safeUiEvent } from "../ui/events.js";
import { ThreadRuntime } from "../core/runtime/thread-runtime.js";
import { snapshotRuntimeOptions, type ThreadRuntimeOptions } from "../core/runtime/options.js";
import { InputRouter, type InputOptions, type InputResult } from "./input-router.js";
import { loadProjectInstructions } from "./project-instructions.js";

import { DEFAULT_COMMIT_ATTRIBUTION, DEFAULT_SYSTEM_PROMPT, formatCommitAttributionPrompt } from "./system-prompt.js";
import { fileEditingPrompt } from "../core/tools/file-editing-prompt.js";
import { getThreadHome } from "../core/config/home.js";
import { GLOBAL_MEMORY_FILE } from "../core/global-memory.js";
import { skillsDirectory } from "../core/skills/loader.js";
import { createAskTool } from "../core/tools/ask.js";

export type { InputResult } from "./input-router.js";
/** Product options for the coding application. Other hosts open ThreadRuntime directly. */
export interface ThreadAppOptions extends Omit<ThreadRuntimeOptions, "search" | "globalMemoryPath"> {
  search?: ThreadRuntimeOptions["search"] | false;
  globalMemoryPath?: string | false;
  commitAttribution?: string;
  /** Read rootPath/AGENTS.md once at startup. Default: true. */
  projectInstructions?: boolean;
}

/** CLI command/presentation adapter over the same runtime used by embedding hosts. */
export class ThreadApp {
  readonly commands = new CommandRegistry();
  readonly extensionApi: ExtensionAPI;
  selectedSessionId: string;
  private readonly commandRouter: ThreadCommandRouter;
  private readonly inputRouter: InputRouter;
  private readonly modelCatalog: ModelCatalog | undefined;
  private readonly skillPaths: readonly string[];
  private inputOperation: { controller: AbortController; done: Promise<InputResult> } | undefined;
  private appClosing: Promise<void> | undefined;

  private constructor(readonly runtime: ThreadRuntime, modelCatalog: ModelCatalog | undefined, skillPaths: readonly string[]) {
    this.modelCatalog = modelCatalog;
    this.skillPaths = skillPaths.map((directory) => path.resolve(runtime.rootPath, directory));
    this.selectedSessionId = runtime.initialSessionId;
    registerBuiltinCommands(this.commands);
    this.commandRouter = new ThreadCommandRouter(this.commands);
    this.extensionApi = createExtensionAPI(runtime, this.commands);
    this.inputRouter = this.createInputRouter();
  }

  static async open(options: ThreadAppOptions): Promise<ThreadApp> {
    const { search, globalMemoryPath, commitAttribution, projectInstructions = true, ...core } = options;
    const skills = core.skills ?? { paths: [skillsDirectory()] };
    const paths = "paths" in skills ? [...skills.paths] : [];
    const modelCatalog = core.modelCatalog;
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
      return new ThreadApp(runtime, modelCatalog, paths);
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }

  async openSession(sessionId: string, options: { signal?: AbortSignal } = {}) {
    this.assertOpen();
    const session = await this.runtime.openSession(sessionId, options);
    this.selectedSessionId = session.id;
    return session;
  }

  private disableWorker(): CommandResult {
    this.runtime.configureAgent(WORKER_PROFILE_ID, false);
    return ephemeral("Worker: Off", true);
  }
  private enableWorker(providerId: string, modelId: string): CommandResult {
    if (!providerId || !modelId || !this.modelCatalog) throw new Error("Worker model selection is unavailable");
    this.runtime.configureAgent(WORKER_PROFILE_ID, true, this.modelCatalog.createClient(providerId, modelId));
    return ephemeral(`Worker: On · ${providerId}/${modelId}`, true);
  }
  private disableDreamer(): CommandResult {
    this.runtime.configureAgent(DREAMER_PROFILE_ID, false);
    return ephemeral("Dreamer: Off", true);
  }
  private enableDreamer(providerId: string, modelId: string): CommandResult {
    if (!providerId || !modelId || !this.modelCatalog) throw new Error("Dreamer model selection is unavailable");
    this.runtime.configureAgent(DREAMER_PROFILE_ID, true, this.modelCatalog.createClient(providerId, modelId));
    return ephemeral(`Dreamer: On · ${providerId}/${modelId}`, true);
  }
  private modelPickerModels(scope: "configured" | "all"): ModelDescriptor[] {
    if (!this.modelCatalog) return [];
    return scope === "all"
      ? (this.modelCatalog.listAll?.() ?? this.modelCatalog.list())
      : this.modelCatalog.list();
  }

  private modelStatus(scope: "configured" | "all" = "configured"): CommandResult {
    const models = this.modelPickerModels(scope);
    const content = this.runtime.model
      ? `Current model: ${this.runtime.model.providerId}/${this.runtime.model.modelId}\nContext window: ${this.runtime.model.contextWindow.toLocaleString("en-US")} tokens\nImages: ${this.runtime.model.acceptsImages === true ? "supported" : "not supported"}\nThinking level: ${this.runtime.thinkingLevel}`
      : "No model selected. Use /model list and /model <provider>/<model>.";
    if (!this.modelCatalog) return ephemeral(content);
    return viewResult(content, {
      type: "model_picker",
      agentId: MAIN_AGENT_PROFILE_ID,
      models,
      currentProviderId: this.runtime.model?.providerId,
      currentModelId: this.runtime.model?.modelId,
      scope,
    });
  }

  private workerStatus(): CommandResult {
    const selected = this.runtime.workerModel;
    const content = this.runtime.workerEnabled
      ? `Worker: On\nWorker model: ${selected?.provider}/${selected?.id}`
      : `Worker: Off${selected ? `\nLast worker model: ${selected.provider}/${selected.id}` : ""}`;
    return viewResult(content, {
      type: "agent_settings",
      agentId: WORKER_PROFILE_ID,
      label: "Worker",
      enabled: this.runtime.workerEnabled,
    });
  }

  private workerModelPicker(scope: "configured" | "all" = "configured"): CommandResult {
    if (!this.modelCatalog) throw new Error("Worker model selection is unavailable");
    const selected = this.runtime.workerModel;
    const models = this.modelPickerModels(scope);
    const choices = models.map((model) => `${model.providerId}/${model.modelId}`).join("\n");
    return viewResult(
      models.length
        ? `Choose a model to enable worker.\nPlain mode: /agent worker model <provider>/<model>\n${choices}`
        : "No worker models are available. Configure a provider or log in first.",
      {
        type: "model_picker",
        agentId: WORKER_PROFILE_ID,
        models,
        currentProviderId: selected?.provider,
        currentModelId: selected?.id,
        scope,
      },
    );
  }

  private dreamerStatus(): CommandResult {
    const selected = this.runtime.dreamerModel;
    const content = [
      `Dreamer: ${this.runtime.dreamerEnabled ? "On" : "Off"}`,
      selected ? `Dreamer model: ${selected.provider}/${selected.id}` : "Dreamer model: not selected",
      this.runtime.dreamerLastError ? `Last error: ${this.runtime.dreamerLastError}` : undefined,
    ].filter((line): line is string => line !== undefined).join("\n");
    return viewResult(content, {
      type: "agent_settings",
      agentId: DREAMER_PROFILE_ID,
      label: "Dreamer",
      enabled: this.runtime.dreamerEnabled,
    });
  }

  private dreamerModelPicker(scope: "configured" | "all" = "configured"): CommandResult {
    if (!this.modelCatalog) throw new Error("Dreamer model selection is unavailable");
    const selected = this.runtime.dreamerModel;
    const models = this.modelPickerModels(scope);
    const choices = models.map((model) => `${model.providerId}/${model.modelId}`).join("\n");
    return viewResult(
      models.length
        ? `Choose the Dreamer model.\nPlain mode: /agent dreamer model <provider>/<model>\n${choices}`
        : "No Dreamer models are available. Configure a provider or log in first.",
      {
        type: "model_picker",
        agentId: DREAMER_PROFILE_ID,
        models,
        currentProviderId: selected?.provider,
        currentModelId: selected?.id,
        scope,
      },
    );
  }

  private agentOverview(): CommandResult {
    const main = this.runtime.model ? `${this.runtime.model.providerId}/${this.runtime.model.modelId}` : "not selected";
    const worker = this.runtime.workerModel;
    const dreamer = this.runtime.dreamerModel;
    const workerDetail = worker ? `${worker.provider}/${worker.id}` : "not selected";
    const dreamerDetail = dreamer ? `${dreamer.provider}/${dreamer.id}` : "not selected";
    const agents = [
      { id: MAIN_AGENT_PROFILE_ID, label: "Main", enabled: true, detail: main },
      {
        id: WORKER_PROFILE_ID,
        label: "Worker",
        enabled: this.runtime.workerEnabled,
        detail: workerDetail,
      },
      {
        id: DREAMER_PROFILE_ID,
        label: "Dreamer",
        enabled: this.runtime.dreamerEnabled,
        detail: this.runtime.dreamerLastError ? `${dreamerDetail} · error: ${this.runtime.dreamerLastError}` : dreamerDetail,
      },
    ];
    const content = [
      `main: on · ${main}`,
      `worker: ${this.runtime.workerEnabled ? "on" : "off"} · ${workerDetail}`,
      `dreamer: ${this.runtime.dreamerEnabled ? "on" : "off"} · ${dreamerDetail}`,
      ...(this.runtime.dreamerLastError ? [`dreamer last error: ${this.runtime.dreamerLastError}`] : []),
      ...this.runtime.agentProfileDiagnostics.map((diagnostic) =>
        `${diagnostic.profileId} ${diagnostic.level}: ${diagnostic.message}`
      ),
    ].join("\n");
    return viewResult(content, { type: "agent_picker", agents });
  }

  private listModels(args: string[], usage: string, agentId = MAIN_AGENT_PROFILE_ID): CommandResult {
    if (!this.modelCatalog || args.length > 1) throw new Error(usage);
    const models = args[0]
      ? (this.modelCatalog.listAll?.(args[0]) ?? this.modelCatalog.list(args[0]))
      : this.modelPickerModels("configured");
    const content = models.map((item) =>
      `${item.providerId}/${item.modelId} — ${item.name}, ${item.contextWindow.toLocaleString("en-US")} context${item.acceptsImages ? ", vision" : ""}`
    ).join("\n") || "(no models)";
    const selected = agentId === WORKER_PROFILE_ID ? this.runtime.workerModel
      : agentId === DREAMER_PROFILE_ID ? this.runtime.dreamerModel
      : this.runtime.model ? { provider: this.runtime.model.providerId, id: this.runtime.model.modelId } : undefined;
    const scope = args[0] ? "all" : "configured";
    return viewResult(content, {
      type: "model_picker",
      agentId,
      models: this.modelPickerModels(scope),
      currentProviderId: selected?.provider,
      currentModelId: selected?.id,
      scope,
      filter: args[0] ? `${args[0]}/` : "",
    });
  }

  private handleSecondaryModelCommand(
    id: typeof WORKER_PROFILE_ID | typeof DREAMER_PROFILE_ID,
    args: string[],
  ): CommandResult {
    const picker = (scope: "configured" | "all" = "configured") =>
      id === WORKER_PROFILE_ID ? this.workerModelPicker(scope) : this.dreamerModelPicker(scope);
    if (args.length === 0) return picker();
    if (args.length === 1 && args[0] === "all") return picker("all");
    if (args[0] === "list") return this.listModels(args.slice(1), `Usage: /agent ${id} model list [provider]`, id);
    if (args.length === 1 && args[0]!.includes("/")) {
      const separator = args[0]!.indexOf("/");
      const providerId = args[0]!.slice(0, separator);
      const modelId = args[0]!.slice(separator + 1);
      return id === WORKER_PROFILE_ID
        ? this.enableWorker(providerId, modelId)
        : this.enableDreamer(providerId, modelId);
    }
    throw new Error(`Usage: /agent ${id} model [all|list [provider]|<provider>/<model>]`);
  }

  private handleAgentCommand(args: string[]): CommandResult {
    if (args.length === 0) return this.agentOverview();
    const [id, action, ...rest] = args;
    if (id !== MAIN_AGENT_PROFILE_ID && id !== WORKER_PROFILE_ID && id !== DREAMER_PROFILE_ID) {
      throw new Error(`Unknown agent: ${id}`);
    }
    if (!action) {
      if (id === MAIN_AGENT_PROFILE_ID) return this.modelStatus();
      return id === WORKER_PROFILE_ID ? this.workerStatus() : this.dreamerStatus();
    }
    if (action === "model") {
      if (id === MAIN_AGENT_PROFILE_ID) return this.handleModelCommand(rest);
      return this.handleSecondaryModelCommand(id, rest);
    }
    if ((action === "on" || action === "off") && id !== MAIN_AGENT_PROFILE_ID && rest.length === 0) {
      if (action === "off") return id === WORKER_PROFILE_ID
        ? this.disableWorker()
        : this.disableDreamer();
      const selected = id === WORKER_PROFILE_ID ? this.runtime.workerModel : this.runtime.dreamerModel;
      if (!selected) return id === WORKER_PROFILE_ID
        ? this.workerModelPicker()
        : this.dreamerModelPicker();
      return id === WORKER_PROFILE_ID
        ? this.enableWorker(selected.provider, selected.id)
        : this.enableDreamer(selected.provider, selected.id);
    }
    throw new Error("Usage: /agent [main|worker|dreamer] [model [all|list [provider]|<provider>/<model>]|on|off]");
  }

  private handleModelCommand(args: string[]): CommandResult {
    if (args.length === 0) return this.modelStatus();
    if (args[0] === "all" && args.length === 1) return this.modelStatus("all");
    if (args[0] === "list") {
      return this.listModels(args.slice(1), "Usage: /model list [provider]");
    }
    let providerId: string;
    let modelId: string;
    if (args.length === 1 && args[0]!.includes("/")) {
      const separator = args[0]!.indexOf("/");
      providerId = args[0]!.slice(0, separator);
      modelId = args[0]!.slice(separator + 1);
    } else if (args.length === 2) {
      [providerId, modelId] = args as [string, string];
    } else throw new Error("Usage: /model <provider>/<model>");
    if (!providerId || !modelId || !this.modelCatalog) throw new Error("Model switching is unavailable");
    const previous = this.runtime.model ? `${this.runtime.model.providerId}/${this.runtime.model.modelId}` : "none";
    this.runtime.selectModel(providerId, modelId);
    return ephemeral(`Switched model from ${previous} to ${providerId}/${modelId}`, true);
  }

  private describeSkills(): string {
    return [
      ...this.skillPaths.map((directory) => `Skills directory: ${directory}`),
      this.runtime.skills.length ? `Loaded skills: ${this.runtime.skills.length}` : "No skills loaded for this application.",
      ...this.runtime.skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.filePath})`),
      ...this.runtime.skillDiagnostics.map((item) => `${item.kind}: ${item.message} (${item.path})`),
    ].join("\n");
  }

  private createInputRouter(): InputRouter {
    return new InputRouter({
      newSession: async (options) => {
        safeUiEvent(options.onUiEvent, { type: "command_started", name: "new" });
        try {
          const session = await this.runtime.createSession(options);
          this.selectedSessionId = session.id;
          safeUiEvent(options.onUiEvent, { type: "session_changed", sessionId: session.id, liveTipTurnId: null, reason: "new" });
          safeUiEvent(options.onUiEvent, { type: "command_finished", name: "new", ok: true });
          const warnings = this.runtime.agentProfileDiagnostics.filter((item) => item.profileId === "main").map((item) => `Warning: ${item.message}`);
          return { kind: "command", result: ephemeral([`Created empty Session ${session.id} from Root; workspace unchanged`, ...warnings].join("\n"), true) };
        } catch (error) {
          safeUiEvent(options.onUiEvent, { type: "command_finished", name: "new", ok: false });
          throw error;
        }
      },
      agent: async (args) => ({ kind: "command", result: this.handleAgentCommand(args) }),
      model: async (args) => ({ kind: "command", result: this.handleModelCommand(args) }),
      skill: async (name, extra, options) => {
        if (!name) return { kind: "command", result: viewResult(this.describeSkills(), {
          type: "command_picker", title: "Skills",
          items: this.runtime.skills.map((skill) => ({ label: skill.name, description: skill.description, command: `/skill ${skill.name} `, submit: false })),
          emptyText: this.skillPaths.length
            ? `No skills loaded. Add skills under ${this.skillPaths.join(", ")}`
            : "No skills loaded for this application.",
        }) };
        if (!this.runtime.model) throw new Error("/skill requires a configured model");
        return { kind: "turn", result: await this.runtime.invokeSkill(this.selectedSessionId, name, extra, options) };
      },
      compact: async (options) => {
        if (!this.runtime.model) throw new Error("/compact requires a configured model");
        safeUiEvent(options.onUiEvent, { type: "command_started", name: "compact" });
        try {
          const result = await this.runtime.compact(this.selectedSessionId, options);
          safeUiEvent(options.onUiEvent, { type: "command_finished", name: "compact", ok: true });
          return { kind: "command", result: ephemeral(result.compacted
            ? `Context compacted: ${result.summarizedSteps} step(s) summarized; ${result.retainedSteps} retained; ${result.tokensBefore - result.tokensAfter} estimated tokens freed`
            : "Nothing can be compacted with a meaningful estimated token reduction", result.compacted) };
        } catch (error) {
          safeUiEvent(options.onUiEvent, { type: "command_finished", name: "compact", ok: false });
          throw error;
        }
      },
      session: (args, options) => this.routeThreadCommand(args.length === 0 ? "/thread sessions" : `/thread open ${args.join(" ")}`, options),
      rewind: async (args, options) => {
        if (args.length > 1) throw new Error("Usage: /rewind [turn-id-or-user-entry-id]");
        if (args.length === 0) {
          const items = buildRewindItems(this.commandContext(options.signal));
          return { kind: "command", result: items.length
            ? viewResult(this.runtime.fileCheckpoints
              ? "Choose a current-path user message. Rewind restores recorded edit/write changes; bash changes are not tracked. Later changes to recorded files are overwritten."
              : "Choose a current-path user message. Rewind changes the conversation context and leaves workspace files unchanged.", { type: "rewind", items })
            : ephemeral("(no user turns on the current live path)") };
        }
        const candidate = await this.runtime.rewind(this.selectedSessionId, args[0]!, options);
        safeUiEvent(options.onUiEvent, { type: "session_changed", sessionId: this.selectedSessionId,
          liveTipTurnId: this.runtime.readSession(this.selectedSessionId).liveTipTurnId, reason: "rewind" });
        return { kind: "command", result: ephemeral(`Rewound to before ${candidate.turnId}; prior path retained`, true) };
      },
      thread: (input, options) => this.routeThreadCommand(input, options),
      turn: async (input, options) => {
        if (!this.runtime.model) throw new Error("No model configured. Use /model list and /model <provider>/<model>.");
        if (options.images?.length && this.runtime.model.acceptsImages !== true) {
          throw new Error("Current model does not accept images. Use /model to pick a vision model.");
        }
        return { kind: "turn", result: await this.runtime.prompt(this.selectedSessionId, input, options) };
      },
    });
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
      await this.runtime.close();
    });
    input?.controller.abort(new DOMException("Thread application closed", "AbortError"));
    return this.appClosing;
  }
}
