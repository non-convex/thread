import type { CacheRetention, Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentRuntime } from "../agent/runtime.js";
import { DEFAULT_SYSTEM_PROMPT } from "../agent/messages.js";
import type { ModelCatalog, ModelClient, ModelDescriptor } from "../agent/model-client.js";
import type { AgentProfile, AgentProfileDiagnostic } from "../agent-task/model.js";
import { AgentTaskOrchestrator } from "../agent-task/orchestrator.js";
import {
  AgentProfileRegistry,
  createImplementationWorkerProfile,
  DEFAULT_IMPLEMENTATION_WORKER_SETTINGS,
  IMPLEMENTATION_WORKER_PROFILE_ID,
  type ImplementationWorkerProfileSettings,
} from "../agent-task/profile.js";
import { AGENT_TASK_ORCHESTRATION_PROMPT } from "../agent-task/prompt.js";
import { AgentTaskRepository } from "../agent-task/repository.js";
import { createAgentTaskTools } from "../agent-task/tools.js";
import { buildRewindItems, registerBuiltinCommands } from "../commands/builtins.js";
import { ThreadCommandRouter } from "../commands/registry.js";
import {
  CommandRegistry,
  ephemeral,
  viewResult,
  type CommandResult,
} from "../commands/types.js";
import type { ModelSelectionConfig } from "../config/thread-config.js";
import type { ThreadState } from "../config/thread-state.js";
import { ContextBuilder } from "../context/builder.js";
import { createExtensionAPI, type ExtensionAPI } from "../extensions/api.js";
import { ExtensionEvents } from "../extensions/events.js";
import { openProject } from "./open-project.js";
import { Compact } from "./use-cases/compact.js";
import { NewSession } from "./use-cases/new-session.js";
import { Rewind } from "./use-cases/rewind.js";
import { RunTurn } from "./use-cases/run-turn.js";
import type { Project } from "../project/model.js";
import { SessionSearchService } from "../session-tree/search.js";
import { SessionTreeRepository } from "../session-tree/repository.js";
import { SessionTreeService } from "../session-tree/service.js";
import {
  formatSkillsSection,
  loadSkills,
  skillsDirectory,
  type LoadedSkills,
  type Skill,
  type SkillDiagnostic,
} from "../skills/loader.js";
import { createAskTool } from "../tools/ask.js";
import { registerBuiltinTools } from "../tools/builtins.js";
import { createSessionReadTool, createSessionSearchTool } from "../tools/session-recall.js";
import { createSkillTool, formatSkillInvocation } from "../tools/skill.js";
import { ToolRegistry } from "../tools/types.js";
import type { AskPresenter } from "../ui/ask.js";
import { safeUiEvent, type UiEventSink } from "../ui/events.js";
import { WorkspaceStateRepository } from "../workspace-state/repository.js";
import { WorkspaceStateService } from "../workspace-state/service.js";
import { MainAgentController } from "./main-agent-controller.js";
import { RuntimeFactory } from "./runtime-factory.js";
import { InputRouter, type InputOptions, type InputResult } from "./input-router.js";

export type { InputResult } from "./input-router.js";

export interface ThreadAppOptions {
  rootPath: string;
  model?: ModelClient;
  modelCatalog?: ModelCatalog;
  thinkingLevel?: ModelThinkingLevel;
  systemPrompt?: string;
  cacheRetention?: CacheRetention;
  skills?: LoadedSkills;
  workspaceExcludedPaths?: readonly string[];
  implementationWorker?: {
    enabled: boolean;
    model?: ModelClient;
    defaultModel?: ModelSelectionConfig;
    settings?: ImplementationWorkerProfileSettings;
  };
  agentProfileDiagnostics?: readonly AgentProfileDiagnostic[];
  state?: ThreadState;
  onStateChange?: (state: ThreadState) => void;
}

const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "medium";

export class ThreadApp {
  readonly project: Project;
  readonly rootPath: string;
  readonly sessionTree: SessionTreeService;
  readonly workspaceState: WorkspaceStateService;
  readonly search: SessionSearchService;
  readonly agentTasks: AgentTaskOrchestrator;
  readonly tools = new ToolRegistry();
  readonly commands = new CommandRegistry();
  readonly extensionApi: ExtensionAPI;
  private readonly repository: SessionTreeRepository;
  private readonly contextBuilder: ContextBuilder;
  private readonly events = new ExtensionEvents();
  private readonly commandRouter: ThreadCommandRouter;
  private readonly inputRouter: InputRouter;
  private readonly loadedSkills: LoadedSkills;
  private readonly modelCatalog: ModelCatalog | undefined;
  private readonly configuredSystemPrompt: string | undefined;
  private readonly cacheRetention: CacheRetention | undefined;
  private readonly mainAgent: MainAgentController;
  private readonly workerSettings: ImplementationWorkerProfileSettings;
  private readonly workerDefaultModel: ModelSelectionConfig | undefined;
  private readonly onStateChange: ((state: ThreadState) => void) | undefined;
  private threadState: ThreadState;
  private agentToolDisposers: (() => void)[] = [];
  private readonly runtimeFactory = new RuntimeFactory();
  private runtime: AgentRuntime | undefined;
  private askPresenter: AskPresenter | undefined;
  private inputActive = false;

  private constructor(options: ThreadAppOptions, values: {
    project: Project;
    repository: SessionTreeRepository;
    tree: SessionTreeService;
    workspace: WorkspaceStateService;
    builder: ContextBuilder;
    search: SessionSearchService;
    skills: LoadedSkills;
    agentTaskRepository: AgentTaskRepository;
  }) {
    this.project = values.project;
    this.rootPath = values.project.rootPath;
    this.repository = values.repository;
    this.sessionTree = values.tree;
    this.workspaceState = values.workspace;
    this.contextBuilder = values.builder;
    this.search = values.search;
    this.loadedSkills = values.skills;
    this.modelCatalog = options.modelCatalog;
    this.configuredSystemPrompt = options.systemPrompt;
    this.cacheRetention = options.cacheRetention;
    this.threadState = structuredClone(options.state ?? {});
    this.onStateChange = options.onStateChange;
    this.workerSettings = options.implementationWorker?.settings ?? DEFAULT_IMPLEMENTATION_WORKER_SETTINGS;
    this.workerDefaultModel = options.implementationWorker?.defaultModel;
    this.mainAgent = new MainAgentController(
      this.sessionTree.tree.id,
      this.cacheRetention,
      options.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
      (state) => this.rememberMainState(state),
    );

    const workerProfile = options.implementationWorker?.enabled && options.implementationWorker.model
      ? this.bindAgentProfile(createImplementationWorkerProfile(options.implementationWorker.model, this.workerSettings))
      : undefined;
    this.agentTasks = new AgentTaskOrchestrator(
      values.agentTaskRepository,
      new AgentProfileRegistry(workerProfile ? [workerProfile] : [], options.agentProfileDiagnostics),
      values.workspace,
    );

    registerBuiltinTools(this.tools);
    this.tools.register(createSessionSearchTool(this.search));
    this.tools.register(createSessionReadTool(this.search));
    if (values.skills.skills.some((skill) => !skill.disableModelInvocation)) {
      this.tools.register(createSkillTool(() => this.loadedSkills.skills));
    }
    this.tools.register(createAskTool());
    this.syncAgentTaskTools();
    registerBuiltinCommands(this.commands);
    this.commandRouter = new ThreadCommandRouter(this.commands);
    this.extensionApi = createExtensionAPI(this.tools, this.commands, this.events);
    this.configureRuntime(options.model);
    this.inputRouter = this.createInputRouter();
  }

  static async open(options: ThreadAppOptions): Promise<ThreadApp> {
    const project = await openProject(options.rootPath);
    let repository: SessionTreeRepository | undefined;
    let agentTaskRepository: AgentTaskRepository | undefined;
    try {
      repository = await SessionTreeRepository.open(project);
      const tree = new SessionTreeService(repository);
      await tree.initialize();
      const workspaceRepository = new WorkspaceStateRepository(project, {
        ...(options.workspaceExcludedPaths ? { excludedPaths: options.workspaceExcludedPaths } : {}),
      });
      await workspaceRepository.initialize();
      const workspace = new WorkspaceStateService(workspaceRepository);
      const builder = new ContextBuilder(tree);
      const search = new SessionSearchService(tree);
      const skills = options.skills ?? await loadSkills();
      agentTaskRepository = await AgentTaskRepository.open(project);
      const app = new ThreadApp(options, { project, repository, tree, workspace, builder, search, skills, agentTaskRepository });
      await app.agentTasks.initialize();
      return app;
    } catch (error) {
      await agentTaskRepository?.close().catch(() => undefined);
      await repository?.close();
      throw error;
    }
  }

  /** Alias retained inside the new API for concise embedding code. */
  get session(): SessionTreeService {
    return this.sessionTree;
  }

  get model(): ModelClient | undefined {
    return this.mainAgent.model;
  }

  get thinkingLevel(): ModelThinkingLevel {
    return this.mainAgent.thinkingLevel;
  }

  get supportsThinking(): boolean {
    return this.mainAgent.supportsThinking;
  }

  get availableThinkingLevels(): readonly ModelThinkingLevel[] {
    return this.mainAgent.availableThinkingLevels;
  }

  get skills(): readonly Skill[] {
    return this.loadedSkills.skills;
  }

  get skillDiagnostics(): readonly SkillDiagnostic[] {
    return this.loadedSkills.diagnostics;
  }

  get agentProfileDiagnostics(): readonly AgentProfileDiagnostic[] {
    return this.agentTasks.profiles.diagnostics;
  }

  get subagentEnabled(): boolean {
    return this.agentTasks.enabled;
  }

  get subagentModel(): ModelSelectionConfig | undefined {
    const profile = this.agentTasks.profiles.get(IMPLEMENTATION_WORKER_PROFILE_ID);
    if (profile) return { provider: profile.model.providerId, id: profile.model.modelId };
    return this.threadState.agents?.[IMPLEMENTATION_WORKER_PROFILE_ID]?.model ?? this.workerDefaultModel;
  }

  agentTaskSummaries(parentTurnId: string) {
    return this.agentTasks.summariesForTurn(parentTurnId);
  }

  agentTaskDetailsForTurn(parentTurnId: string) {
    return [...this.agentTasks.repository.projection.tasks.values()]
      .filter((task) => task.parentTurnId === parentTurnId)
      .map((task) => ({
        task: structuredClone(task),
        summary: this.agentTasks.repository.projection.summary(task.id),
      }));
  }

  readAgentTask(taskId: string, view: "summary" | "diff" | "trace", options?: { path?: string; cursor?: number; limit?: number; fullTrace?: boolean }) {
    return this.agentTasks.inspect(taskId, view, options);
  }

  setAskPresenter(presenter: AskPresenter | undefined): () => void {
    this.askPresenter = presenter;
    return () => {
      if (this.askPresenter === presenter) this.askPresenter = undefined;
    };
  }

  contextOccupancy(tipTurnId: string | null = this.sessionTree.activeLiveTip): { percent: number; requestTokens: number } | undefined {
    if (!this.model || !this.runtime) return undefined;
    const messages = this.contextBuilder.build(tipTurnId ?? undefined).messages;
    const { requestTokens } = this.runtime.estimateRequestBudget(messages);
    return {
      percent: Math.min(999, Math.round((requestTokens / this.model.contextWindow) * 100)),
      requestTokens,
    };
  }

  liveContextMessages(): Message[] {
    return this.contextBuilder.build().messages;
  }

  cycleThinkingLevel(): ModelThinkingLevel | undefined {
    const level = this.mainAgent.cycleThinkingLevel();
    if (level) this.rebuildRuntime();
    return level;
  }

  private rememberMainState(main: Pick<ThreadState, "model" | "thinkingLevel">): void {
    this.threadState = {
      ...this.threadState,
      ...(main.model ? { model: main.model } : {}),
      ...(main.thinkingLevel ? { thinkingLevel: main.thinkingLevel } : {}),
    };
    this.onStateChange?.(structuredClone(this.threadState));
  }

  private rememberSubagentState(enabled: boolean, model: ModelSelectionConfig | undefined): void {
    this.threadState = {
      ...this.threadState,
      agents: {
        ...this.threadState.agents,
        [IMPLEMENTATION_WORKER_PROFILE_ID]: {
          enabled,
          ...(model ? { model } : {}),
        },
      },
    };
    this.onStateChange?.(structuredClone(this.threadState));
  }

  private syncAgentTaskTools(): void {
    if (!this.agentTasks.enabled) {
      for (const dispose of this.agentToolDisposers.splice(0)) dispose();
      return;
    }
    if (this.agentToolDisposers.length > 0) return;
    const taskTools = createAgentTaskTools(this.agentTasks);
    const conflict = taskTools.find((tool) => this.tools.get(tool.name));
    if (conflict) throw new Error(`Cannot enable subagents because tool ${conflict.name} is already registered`);
    const registered: (() => void)[] = [];
    try {
      for (const tool of taskTools) registered.push(this.tools.register(tool));
      this.agentToolDisposers = registered;
    } catch (error) {
      for (const dispose of registered.reverse()) dispose();
      throw error;
    }
  }

  private disableSubagent(): CommandResult {
    const previous = this.subagentModel;
    this.agentTasks.profiles.delete(IMPLEMENTATION_WORKER_PROFILE_ID);
    this.agentTasks.profiles.setDiagnostics([]);
    this.syncAgentTaskTools();
    this.rebuildRuntime();
    this.rememberSubagentState(false, previous);
    return ephemeral("Subagent: Off", true);
  }

  private enableSubagent(providerId: string, modelId: string): CommandResult {
    if (!providerId || !modelId || !this.modelCatalog) throw new Error("Worker model selection is unavailable");
    const model = this.modelCatalog.createClient(providerId, modelId);
    const profile = this.bindAgentProfile(createImplementationWorkerProfile(model, this.workerSettings));
    const previous = this.agentTasks.profiles.get(IMPLEMENTATION_WORKER_PROFILE_ID);
    this.agentTasks.profiles.set(profile);
    try {
      this.syncAgentTaskTools();
    } catch (error) {
      if (previous) this.agentTasks.profiles.set(previous);
      else this.agentTasks.profiles.delete(IMPLEMENTATION_WORKER_PROFILE_ID);
      throw error;
    }
    this.agentTasks.profiles.setDiagnostics([]);
    this.rebuildRuntime();
    this.rememberSubagentState(true, { provider: providerId, id: modelId });
    return ephemeral(`Subagent: On · worker ${providerId}/${modelId}`, true);
  }

  private bindAgentProfile(profile: AgentProfile): AgentProfile {
    let model = profile.model;
    const cacheBindable = model as ModelClient & { withCacheKey?: (key: string) => ModelClient };
    const cacheKey = `${this.sessionTree.tree.id}:${profile.id}`;
    if (cacheBindable.withCacheKey && model.cacheKey !== cacheKey) model = cacheBindable.withCacheKey(cacheKey);
    const retentionBindable = model as ModelClient & { withCacheRetention?: (retention: CacheRetention | undefined) => ModelClient };
    if (retentionBindable.withCacheRetention && model.cacheRetention !== this.cacheRetention) {
      model = retentionBindable.withCacheRetention(this.cacheRetention);
    }
    return { ...profile, model };
  }

  private configureRuntime(model: ModelClient | undefined): void {
    this.mainAgent.select(model);
    this.rebuildRuntime();
  }

  private rebuildRuntime(): void {
    const model = this.mainAgent.model;
    if (!model) {
      this.runtime = undefined;
      return;
    }
    const skills = formatSkillsSection(this.loadedSkills.skills);
    const systemPrompt = [
      this.configuredSystemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      this.agentTasks.enabled ? AGENT_TASK_ORCHESTRATION_PROMPT : "",
      skills,
    ].filter(Boolean).join("\n\n");
    this.runtime = this.runtimeFactory.create({
      model,
      ...(this.mainAgent.reasoning ? { reasoning: this.mainAgent.reasoning } : {}),
      rootPath: this.rootPath,
      systemPrompt,
      tree: this.sessionTree,
      workspace: this.workspaceState,
      contextBuilder: this.contextBuilder,
      tools: this.tools,
      extensions: this.events,
      agentTasks: this.agentTasks,
      askPresenter: () => this.askPresenter,
    });
  }

  private modelPickerModels(scope: "configured" | "all"): ModelDescriptor[] {
    if (!this.modelCatalog) return [];
    return scope === "all"
      ? (this.modelCatalog.listAll?.() ?? this.modelCatalog.list())
      : this.modelCatalog.list();
  }

  private modelStatus(scope: "configured" | "all" = "configured"): CommandResult {
    const models = this.modelPickerModels(scope);
    const content = this.model
      ? `Current model: ${this.model.providerId}/${this.model.modelId}\nContext window: ${this.model.contextWindow.toLocaleString("en-US")} tokens\nThinking level: ${this.thinkingLevel}`
      : "No model selected. Use /model list and /model <provider>/<model>.";
    if (!this.modelCatalog) return ephemeral(content);
    return viewResult(content, {
      type: "model_picker",
      target: "main",
      models,
      currentProviderId: this.model?.providerId,
      currentModelId: this.model?.modelId,
      scope,
    });
  }

  private subagentStatus(): CommandResult {
    const selected = this.subagentModel;
    const content = this.subagentEnabled
      ? `Subagent: On\nWorker model: ${selected?.provider}/${selected?.id}`
      : `Subagent: Off${selected ? `\nLast worker model: ${selected.provider}/${selected.id}` : ""}`;
    return viewResult(content, { type: "subagent_settings", enabled: this.subagentEnabled });
  }

  private workerModelPicker(scope: "configured" | "all" = "configured"): CommandResult {
    if (!this.modelCatalog) throw new Error("Worker model selection is unavailable");
    const selected = this.subagentModel;
    const models = this.modelPickerModels(scope);
    const choices = models.map((model) => `${model.providerId}/${model.modelId}`).join("\n");
    return viewResult(
      models.length
        ? `Choose the implementation-worker model to enable subagents.\nPlain mode: /subagent <provider>/<model>\n${choices}`
        : "No worker models are available. Configure a provider or log in first.",
      {
        type: "model_picker",
        target: IMPLEMENTATION_WORKER_PROFILE_ID,
        models,
        currentProviderId: selected?.provider,
        currentModelId: selected?.id,
        scope,
      },
    );
  }

  private handleSubagentCommand(args: string[]): CommandResult {
    if (args.length === 0) return this.subagentStatus();
    if (args.length === 1 && args[0] === "off") return this.disableSubagent();
    if (args.length === 1 && args[0] === "on") return this.workerModelPicker();
    if (args.length === 2 && args[0] === "on" && args[1] === "all") return this.workerModelPicker("all");
    if (args.length === 1 && args[0]!.includes("/")) {
      const separator = args[0]!.indexOf("/");
      return this.enableSubagent(args[0]!.slice(0, separator), args[0]!.slice(separator + 1));
    }
    throw new Error("Usage: /subagent [off|on [all]|<provider>/<model>]");
  }

  private handleModelCommand(args: string[]): CommandResult {
    if (args.length === 0) return this.modelStatus();
    if (args[0] === "all" && args.length === 1) return this.modelStatus("all");
    if (args[0] === "list") {
      if (!this.modelCatalog || args.length > 2) throw new Error("Usage: /model list [provider]");
      const models = args[1]
        ? (this.modelCatalog.listAll?.(args[1]) ?? this.modelCatalog.list(args[1]))
        : this.modelPickerModels("configured");
      return ephemeral(models.map((item) =>
        `${item.providerId}/${item.modelId} — ${item.name}, ${item.contextWindow.toLocaleString("en-US")} context`
      ).join("\n") || "(no models)");
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
    const previous = this.model ? `${this.model.providerId}/${this.model.modelId}` : "none";
    this.configureRuntime(this.modelCatalog.createClient(providerId, modelId));
    this.mainAgent.remember();
    return ephemeral(`Switched model from ${previous} to ${providerId}/${modelId}`, true);
  }

  private describeSkills(): string {
    return [
      `skills directory: ${skillsDirectory()}`,
      ...this.skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ...this.skillDiagnostics.map((item) => `${item.kind}: ${item.message} (${item.path})`),
    ].join("\n");
  }

  private createInputRouter(): InputRouter {
    return new InputRouter({
      newSession: async (options) => {
        safeUiEvent(options.onUiEvent, { type: "command_started", name: "new" });
        try {
          options.signal.throwIfAborted();
          const session = await new NewSession(this.sessionTree).execute();
          safeUiEvent(options.onUiEvent, { type: "session_changed", sessionId: session.id, liveTipTurnId: null, reason: "new" });
          safeUiEvent(options.onUiEvent, { type: "command_finished", name: "new", ok: true });
          return { kind: "command", result: ephemeral(`Created empty Session ${session.id} from Root; workspace unchanged`, true) };
        } catch (error) {
          safeUiEvent(options.onUiEvent, { type: "command_finished", name: "new", ok: false });
          throw error;
        }
      },
      model: async (args) => ({ kind: "command", result: this.handleModelCommand(args) }),
      subagent: async (args) => ({ kind: "command", result: this.handleSubagentCommand(args) }),
      skill: async (name, extra, options) => {
        if (!name) return { kind: "command", result: ephemeral(this.describeSkills()) };
        const skill = this.skills.find((item) => item.name === name);
        if (!skill) throw new Error(`Unknown skill: ${name}`);
        if (!this.runtime) throw new Error("/skill requires a configured model");
        return { kind: "turn", result: await new RunTurn(this.runtime).execute(formatSkillInvocation(skill, extra), options) };
      },
      compact: async (options) => {
        if (!this.runtime) throw new Error("/compact requires a configured model");
        safeUiEvent(options.onUiEvent, { type: "command_started", name: "compact" });
        try {
          const result = await new Compact(this.runtime).execute(options);
          safeUiEvent(options.onUiEvent, { type: "command_finished", name: "compact", ok: true });
          return { kind: "command", result: ephemeral(result.compacted
            ? `Compaction entry appended: ${result.summarizedTurns} turn(s) summarized; ${result.retainedTurns} retained`
            : "Nothing to compact without removing one of the newest two complete turns", result.compacted) };
        } catch (error) {
          safeUiEvent(options.onUiEvent, { type: "command_finished", name: "compact", ok: false });
          throw error;
        }
      },
      session: (args, options) => {
        const routed = args.length === 0 ? "/thread sessions" : `/thread open ${args.join(" ")}`;
        return this.routeThreadCommand(routed, options);
      },
      rewind: async (args, options) => {
        if (args.length > 1) throw new Error("Usage: /rewind [turn-id-or-user-entry-id]");
        if (args.length === 0) {
          const items = buildRewindItems(this.commandContext(options.signal));
          return { kind: "command", result: items.length
            ? viewResult("Choose a current-path user message to rewind before.", { type: "rewind", items })
            : ephemeral("(no user turns on the current live path)") };
        }
        const candidate = await this.rewindTo(args[0]!);
        safeUiEvent(options.onUiEvent, {
          type: "session_changed",
          sessionId: this.sessionTree.activeSession.id,
          liveTipTurnId: this.sessionTree.activeLiveTip,
          reason: "rewind",
        });
        return { kind: "command", result: ephemeral(`Rewound to before ${candidate.turnId}; prior path retained`, true) };
      },
      thread: (input, options) => this.routeThreadCommand(input, options),
      turn: async (input, options) => {
        if (!this.runtime) throw new Error("No model configured. Use /model list and /model <provider>/<model>.");
        return { kind: "turn", result: await new RunTurn(this.runtime).execute(input, options) };
      },
    });
  }

  async handleInput(
    input: string,
    options: InputOptions,
  ): Promise<InputResult> {
    if (this.inputActive) throw new Error("Wait for the active turn or command to finish");
    this.inputActive = true;
    try {
      return await this.handleInputInner(input, options);
    } finally {
      this.inputActive = false;
    }
  }

  private async handleInputInner(
    input: string,
    options: InputOptions,
  ): Promise<InputResult> {
    return this.inputRouter.route(input, options);
  }

  private commandContext(signal: AbortSignal) {
    return {
      rootPath: this.rootPath,
      tree: this.sessionTree,
      search: this.search,
      skills: this.skills,
      skillDiagnostics: this.skillDiagnostics,
      signal,
    };
  }

  private async routeThreadCommand(
    input: string,
    options: { signal: AbortSignal; onUiEvent?: UiEventSink },
  ): Promise<InputResult> {
    const beforeSession = this.sessionTree.activeSession.id;
    const result = await this.commandRouter.route(input, this.commandContext(options.signal));
    if (!result) throw new Error(`Could not route command: ${input}`);
    if (beforeSession !== this.sessionTree.activeSession.id) {
      safeUiEvent(options.onUiEvent, {
        type: "session_changed",
        sessionId: this.sessionTree.activeSession.id,
        liveTipTurnId: this.sessionTree.activeLiveTip,
        reason: "opened",
      });
    }
    return { kind: "command", result };
  }

  rewindTo(turnIdOrUserEntryId: string) {
    return new Rewind(this.sessionTree, this.workspaceState).execute(turnIdOrUserEntryId);
  }

  async fsck(): Promise<string[]> {
    const issues: string[] = [];
    for (const session of this.sessionTree.projection.sessions.values()) {
      try {
        this.sessionTree.livePath(session.id);
      } catch (error) {
        issues.push(`session ${session.id} live path: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const turn of this.sessionTree.projection.turns.values()) {
      const entries = this.sessionTree.projection.entriesByTurn.get(turn.id) ?? [];
      if (entries[0]?.id !== turn.userEntryId || entries[0]?.type !== "message" || entries[0].message.role !== "user") {
        issues.push(`turn ${turn.id} has no leading user entry`);
      }
      try {
        await this.workspaceState.verify(turn.workspaceStateId);
      } catch (error) {
        issues.push(`turn ${turn.id} workspace state: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return issues;
  }

  cleanupWorkspaceStates() {
    const referenced = this.agentTasks.referencedStateIds();
    for (const turn of this.sessionTree.projection.turns.values()) referenced.add(turn.workspaceStateId);
    return this.workspaceState.cleanup(referenced);
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    await this.agentTasks.close().catch((error) => failures.push(error));
    await this.repository.close().catch((error) => failures.push(error));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Thread repositories failed to close cleanly");
  }
}
