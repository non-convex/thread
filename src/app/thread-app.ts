import type { CacheRetention, Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentRuntime } from "../agent/runtime.js";
import { DEFAULT_SYSTEM_PROMPT } from "../agent/system-prompt.js";
import type { ModelCatalog, ModelClient, ModelDescriptor } from "../agent/model-client.js";
import {
  AgentProfileRegistry,
  MAIN_AGENT_PROFILE_ID,
  type AgentProfile,
  type AgentProfileDiagnostic,
} from "../agent/profile.js";
import { AgentTaskOrchestrator } from "../agent-task/orchestrator.js";
import {
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
import { createDreamerProfile, DEFAULT_DREAMER_THINKING_LEVEL, DREAMER_PROFILE_ID } from "../dreamer/profile.js";
import { DreamerScheduler } from "../dreamer/scheduler.js";
import { createExtensionAPI, type ExtensionAPI } from "../extensions/api.js";
import { ExtensionEvents } from "../extensions/events.js";
import { formatGlobalMemoryPrompt, GlobalMemorySnapshots } from "../global-memory.js";
import type { Project } from "../project/model.js";
import { ProjectService } from "../project/service.js";
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
import { createRuntime } from "./create-runtime.js";
import { MainAgentController } from "./main-agent-controller.js";
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
  dreamer?: {
    enabled: boolean;
    model?: ModelClient;
    defaultModel?: ModelSelectionConfig;
    thinkingLevel?: ModelThinkingLevel;
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
  readonly agentProfiles: AgentProfileRegistry;
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
  private readonly dreamerDefaultModel: ModelSelectionConfig | undefined;
  private readonly dreamerThinkingLevel: ModelThinkingLevel;
  private readonly globalMemory: GlobalMemorySnapshots;
  private readonly dreamer: DreamerScheduler;
  private readonly onStateChange: ((state: ThreadState) => void) | undefined;
  private threadState: ThreadState;
  private agentToolDisposers: (() => void)[] = [];
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
    globalMemory: GlobalMemorySnapshots;
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
    this.dreamerDefaultModel = options.dreamer?.defaultModel;
    this.dreamerThinkingLevel = options.dreamer?.thinkingLevel ?? DEFAULT_DREAMER_THINKING_LEVEL;
    this.globalMemory = values.globalMemory;
    this.mainAgent = new MainAgentController(
      this.sessionTree.tree.id,
      this.cacheRetention,
      options.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
      (state) => this.rememberMainState(state),
    );

    const workerProfile = options.implementationWorker?.enabled && options.implementationWorker.model
      ? this.bindAgentProfile(createImplementationWorkerProfile(options.implementationWorker.model, this.workerSettings))
      : undefined;
    const dreamerProfile = options.dreamer?.enabled && options.dreamer.model
      ? this.bindAgentProfile(createDreamerProfile(options.dreamer.model, this.dreamerThinkingLevel))
      : undefined;
    const profiles = [workerProfile, dreamerProfile].filter((profile): profile is AgentProfile => profile !== undefined);
    this.agentProfiles = new AgentProfileRegistry(profiles, options.agentProfileDiagnostics);
    this.agentTasks = new AgentTaskOrchestrator(
      values.agentTaskRepository,
      this.agentProfiles,
      values.project.rootPath,
      this.workerSettings,
    );
    this.dreamer = new DreamerScheduler(
      values.project.rootPath,
      this.globalMemory.filePath,
      dreamerProfile,
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
    const project = await ProjectService.open(options.rootPath);
    let repository: SessionTreeRepository | undefined;
    let agentTaskRepository: AgentTaskRepository | undefined;
    try {
      repository = await SessionTreeRepository.open(project);
      const tree = new SessionTreeService(repository);
      await tree.initialize();
      const globalMemory = await GlobalMemorySnapshots.open([...tree.projection.sessions.keys()]);
      const workspaceRepository = new WorkspaceStateRepository(project, {
        ...(options.workspaceExcludedPaths ? { excludedPaths: options.workspaceExcludedPaths } : {}),
      });
      await workspaceRepository.initialize();
      const workspace = new WorkspaceStateService(workspaceRepository);
      const builder = new ContextBuilder(tree);
      const search = new SessionSearchService(tree);
      const skills = options.skills ?? await loadSkills();
      agentTaskRepository = await AgentTaskRepository.open(project);
      const app = new ThreadApp(options, {
        project,
        repository,
        tree,
        workspace,
        builder,
        search,
        skills,
        agentTaskRepository,
        globalMemory,
      });
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
    const memoryDiagnostic = this.globalMemory.diagnostic;
    return [
      ...this.agentProfiles.diagnostics,
      ...(memoryDiagnostic
        ? [{ profileId: "main", level: "warning" as const, message: memoryDiagnostic }]
        : []),
    ];
  }

  get subagentEnabled(): boolean {
    return this.agentTasks.enabled;
  }

  get subagentModel(): ModelSelectionConfig | undefined {
    const profile = this.agentProfiles.get(IMPLEMENTATION_WORKER_PROFILE_ID);
    if (profile) return { provider: profile.model.providerId, id: profile.model.modelId };
    return this.threadState.agents?.[IMPLEMENTATION_WORKER_PROFILE_ID]?.model ?? this.workerDefaultModel;
  }

  get dreamerEnabled(): boolean {
    return this.dreamer.enabled;
  }

  get dreamerModel(): ModelSelectionConfig | undefined {
    const profile = this.agentProfiles.get(DREAMER_PROFILE_ID);
    if (profile) return { provider: profile.model.providerId, id: profile.model.modelId };
    return this.threadState.agents?.dreamer?.model ?? this.dreamerDefaultModel;
  }

  get dreamerLastError(): string | undefined {
    return this.dreamer.lastError;
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

  private rememberSecondaryAgentState(
    id: typeof IMPLEMENTATION_WORKER_PROFILE_ID | typeof DREAMER_PROFILE_ID,
    enabled: boolean,
    model: ModelSelectionConfig | undefined,
  ): void {
    this.threadState = {
      ...this.threadState,
      agents: {
        ...this.threadState.agents,
        [id]: {
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
    this.agentProfiles.delete(IMPLEMENTATION_WORKER_PROFILE_ID);
    this.agentProfiles.clearDiagnostics(IMPLEMENTATION_WORKER_PROFILE_ID);
    this.syncAgentTaskTools();
    this.rebuildRuntime();
    this.rememberSecondaryAgentState(IMPLEMENTATION_WORKER_PROFILE_ID, false, previous);
    return ephemeral("Subagent: Off", true);
  }

  private enableSubagent(providerId: string, modelId: string): CommandResult {
    if (!providerId || !modelId || !this.modelCatalog) throw new Error("Worker model selection is unavailable");
    const model = this.modelCatalog.createClient(providerId, modelId);
    const profile = this.bindAgentProfile(createImplementationWorkerProfile(model, this.workerSettings));
    const previous = this.agentProfiles.get(IMPLEMENTATION_WORKER_PROFILE_ID);
    this.agentProfiles.set(profile);
    try {
      this.syncAgentTaskTools();
    } catch (error) {
      if (previous) this.agentProfiles.set(previous);
      else this.agentProfiles.delete(IMPLEMENTATION_WORKER_PROFILE_ID);
      throw error;
    }
    this.agentProfiles.clearDiagnostics(IMPLEMENTATION_WORKER_PROFILE_ID);
    this.rebuildRuntime();
    this.rememberSecondaryAgentState(IMPLEMENTATION_WORKER_PROFILE_ID, true, { provider: providerId, id: modelId });
    return ephemeral(`Subagent: On · worker ${providerId}/${modelId}`, true);
  }

  private disableDreamer(): CommandResult {
    const previous = this.dreamerModel;
    this.agentProfiles.delete(DREAMER_PROFILE_ID);
    this.agentProfiles.clearDiagnostics(DREAMER_PROFILE_ID);
    this.dreamer.setProfile(undefined);
    this.rememberSecondaryAgentState(DREAMER_PROFILE_ID, false, previous);
    return ephemeral("Dreamer: Off", true);
  }

  private enableDreamer(providerId: string, modelId: string): CommandResult {
    if (!providerId || !modelId || !this.modelCatalog) throw new Error("Dreamer model selection is unavailable");
    const model = this.modelCatalog.createClient(providerId, modelId);
    const profile = this.bindAgentProfile(createDreamerProfile(model, this.dreamerThinkingLevel));
    this.agentProfiles.set(profile);
    this.agentProfiles.clearDiagnostics(DREAMER_PROFILE_ID);
    this.dreamer.setProfile(profile);
    this.rememberSecondaryAgentState(DREAMER_PROFILE_ID, true, { provider: providerId, id: modelId });
    return ephemeral(`Dreamer: On · ${providerId}/${modelId}`, true);
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
      this.agentProfiles.delete(MAIN_AGENT_PROFILE_ID);
      this.runtime = undefined;
      return;
    }
    const skills = formatSkillsSection(this.loadedSkills.skills);
    const systemPrompt = [
      this.configuredSystemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      this.agentTasks.enabled ? AGENT_TASK_ORCHESTRATION_PROMPT : "",
      skills,
      formatGlobalMemoryPrompt(
        this.globalMemory.filePath,
        this.globalMemory.snapshot(this.sessionTree.activeSession.id),
      ),
    ].filter(Boolean).join("\n\n");
    const profile: AgentProfile = {
      id: MAIN_AGENT_PROFILE_ID,
      model,
      thinkingLevel: this.thinkingLevel,
      tools: this.tools,
      systemPrompt,
    };
    this.agentProfiles.set(profile);
    this.runtime = createRuntime({
      model: profile.model,
      ...(this.mainAgent.reasoning ? { reasoning: this.mainAgent.reasoning } : {}),
      rootPath: this.rootPath,
      systemPrompt: profile.systemPrompt,
      tree: this.sessionTree,
      workspace: this.workspaceState,
      contextBuilder: this.contextBuilder,
      tools: profile.tools,
      extensions: this.events,
      agentTasks: this.agentTasks,
      askPresenter: () => this.askPresenter,
      writableExternalPaths: [this.globalMemory.filePath],
      onCompacted: (messages) => this.dreamer.recordCompaction(messages),
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
      ? `Current model: ${this.model.providerId}/${this.model.modelId}\nContext window: ${this.model.contextWindow.toLocaleString("en-US")} tokens\nImages: ${this.model.acceptsImages === true ? "supported" : "not supported"}\nThinking level: ${this.thinkingLevel}`
      : "No model selected. Use /model list and /model <provider>/<model>.";
    if (!this.modelCatalog) return ephemeral(content);
    return viewResult(content, {
      type: "model_picker",
      agentId: MAIN_AGENT_PROFILE_ID,
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
    return viewResult(content, {
      type: "agent_settings",
      agentId: IMPLEMENTATION_WORKER_PROFILE_ID,
      label: "Implementation worker",
      enabled: this.subagentEnabled,
    });
  }

  private workerModelPicker(scope: "configured" | "all" = "configured"): CommandResult {
    if (!this.modelCatalog) throw new Error("Worker model selection is unavailable");
    const selected = this.subagentModel;
    const models = this.modelPickerModels(scope);
    const choices = models.map((model) => `${model.providerId}/${model.modelId}`).join("\n");
    return viewResult(
      models.length
        ? `Choose the implementation-worker model to enable subagents.\nPlain mode: /agent implementation-worker model <provider>/<model>\n${choices}`
        : "No worker models are available. Configure a provider or log in first.",
      {
        type: "model_picker",
        agentId: IMPLEMENTATION_WORKER_PROFILE_ID,
        models,
        currentProviderId: selected?.provider,
        currentModelId: selected?.id,
        scope,
      },
    );
  }

  private dreamerStatus(): CommandResult {
    const selected = this.dreamerModel;
    const content = [
      `Dreamer: ${this.dreamerEnabled ? "On" : "Off"}`,
      selected ? `Dreamer model: ${selected.provider}/${selected.id}` : "Dreamer model: not selected",
      this.dreamerLastError ? `Last error: ${this.dreamerLastError}` : undefined,
    ].filter((line): line is string => line !== undefined).join("\n");
    return viewResult(content, {
      type: "agent_settings",
      agentId: DREAMER_PROFILE_ID,
      label: "Dreamer",
      enabled: this.dreamerEnabled,
    });
  }

  private dreamerModelPicker(scope: "configured" | "all" = "configured"): CommandResult {
    if (!this.modelCatalog) throw new Error("Dreamer model selection is unavailable");
    const selected = this.dreamerModel;
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
    const main = this.model ? `${this.model.providerId}/${this.model.modelId}` : "not selected";
    const worker = this.subagentModel;
    const dreamer = this.dreamerModel;
    const workerDetail = worker ? `${worker.provider}/${worker.id}` : "not selected";
    const dreamerDetail = dreamer ? `${dreamer.provider}/${dreamer.id}` : "not selected";
    const agents = [
      { id: MAIN_AGENT_PROFILE_ID, label: "Main", enabled: true, detail: main },
      {
        id: IMPLEMENTATION_WORKER_PROFILE_ID,
        label: "Implementation worker",
        enabled: this.subagentEnabled,
        detail: workerDetail,
      },
      {
        id: DREAMER_PROFILE_ID,
        label: "Dreamer",
        enabled: this.dreamerEnabled,
        detail: this.dreamerLastError ? `${dreamerDetail} · error: ${this.dreamerLastError}` : dreamerDetail,
      },
    ];
    const content = [
      `main: on · ${main}`,
      `implementation-worker: ${this.subagentEnabled ? "on" : "off"} · ${workerDetail}`,
      `dreamer: ${this.dreamerEnabled ? "on" : "off"} · ${dreamerDetail}`,
      ...(this.dreamerLastError ? [`dreamer last error: ${this.dreamerLastError}`] : []),
      ...this.agentProfileDiagnostics.map((diagnostic) =>
        `${diagnostic.profileId} ${diagnostic.level}: ${diagnostic.message}`
      ),
    ].join("\n");
    return viewResult(content, { type: "agent_picker", agents });
  }

  private listModels(args: string[], usage: string): CommandResult {
    if (!this.modelCatalog || args.length > 1) throw new Error(usage);
    const models = args[0]
      ? (this.modelCatalog.listAll?.(args[0]) ?? this.modelCatalog.list(args[0]))
      : this.modelPickerModels("configured");
    return ephemeral(models.map((item) =>
      `${item.providerId}/${item.modelId} — ${item.name}, ${item.contextWindow.toLocaleString("en-US")} context${item.acceptsImages ? ", vision" : ""}`
    ).join("\n") || "(no models)");
  }

  private handleSecondaryModelCommand(
    id: typeof IMPLEMENTATION_WORKER_PROFILE_ID | typeof DREAMER_PROFILE_ID,
    args: string[],
  ): CommandResult {
    const picker = (scope: "configured" | "all" = "configured") =>
      id === IMPLEMENTATION_WORKER_PROFILE_ID ? this.workerModelPicker(scope) : this.dreamerModelPicker(scope);
    if (args.length === 0) return picker();
    if (args.length === 1 && args[0] === "all") return picker("all");
    if (args[0] === "list") return this.listModels(args.slice(1), `Usage: /agent ${id} model list [provider]`);
    if (args.length === 1 && args[0]!.includes("/")) {
      const separator = args[0]!.indexOf("/");
      const providerId = args[0]!.slice(0, separator);
      const modelId = args[0]!.slice(separator + 1);
      return id === IMPLEMENTATION_WORKER_PROFILE_ID
        ? this.enableSubagent(providerId, modelId)
        : this.enableDreamer(providerId, modelId);
    }
    throw new Error(`Usage: /agent ${id} model [all|list [provider]|<provider>/<model>]`);
  }

  private handleAgentCommand(args: string[]): CommandResult {
    if (args.length === 0) return this.agentOverview();
    const [id, action, ...rest] = args;
    if (id !== MAIN_AGENT_PROFILE_ID && id !== IMPLEMENTATION_WORKER_PROFILE_ID && id !== DREAMER_PROFILE_ID) {
      throw new Error(`Unknown agent: ${id}`);
    }
    if (!action) {
      if (id === MAIN_AGENT_PROFILE_ID) return this.modelStatus();
      return id === IMPLEMENTATION_WORKER_PROFILE_ID ? this.subagentStatus() : this.dreamerStatus();
    }
    if (action === "model") {
      if (id === MAIN_AGENT_PROFILE_ID) return this.handleModelCommand(rest);
      return this.handleSecondaryModelCommand(id, rest);
    }
    if ((action === "on" || action === "off") && id !== MAIN_AGENT_PROFILE_ID && rest.length === 0) {
      if (action === "off") return id === IMPLEMENTATION_WORKER_PROFILE_ID
        ? this.disableSubagent()
        : this.disableDreamer();
      const selected = id === IMPLEMENTATION_WORKER_PROFILE_ID ? this.subagentModel : this.dreamerModel;
      if (!selected) return id === IMPLEMENTATION_WORKER_PROFILE_ID
        ? this.workerModelPicker()
        : this.dreamerModelPicker();
      return id === IMPLEMENTATION_WORKER_PROFILE_ID
        ? this.enableSubagent(selected.provider, selected.id)
        : this.enableDreamer(selected.provider, selected.id);
    }
    throw new Error("Usage: /agent [main|implementation-worker|dreamer] [model [all|list [provider]|<provider>/<model>]|on|off]");
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
          const memorySnapshot = await this.globalMemory.loadFresh();
          options.signal.throwIfAborted();
          const session = await this.sessionTree.createSession();
          this.globalMemory.bind(session.id, memorySnapshot);
          this.rebuildRuntime();
          safeUiEvent(options.onUiEvent, { type: "session_changed", sessionId: session.id, liveTipTurnId: null, reason: "new" });
          safeUiEvent(options.onUiEvent, { type: "command_finished", name: "new", ok: true });
          const content = [
            `Created empty Session ${session.id} from Root; workspace unchanged`,
            ...(this.globalMemory.diagnostic ? [`Warning: ${this.globalMemory.diagnostic}`] : []),
          ].join("\n");
          return { kind: "command", result: ephemeral(content, true) };
        } catch (error) {
          safeUiEvent(options.onUiEvent, { type: "command_finished", name: "new", ok: false });
          throw error;
        }
      },
      agent: async (args) => ({ kind: "command", result: this.handleAgentCommand(args) }),
      model: async (args) => ({ kind: "command", result: this.handleModelCommand(args) }),
      skill: async (name, extra, options) => {
        if (!name) return { kind: "command", result: ephemeral(this.describeSkills()) };
        const skill = this.skills.find((item) => item.name === name);
        if (!skill) throw new Error(`Unknown skill: ${name}`);
        if (!this.runtime) throw new Error("/skill requires a configured model");
        return { kind: "turn", result: await this.runtime.run(formatSkillInvocation(skill, extra), options) };
      },
      compact: async (options) => {
        if (!this.runtime) throw new Error("/compact requires a configured model");
        safeUiEvent(options.onUiEvent, { type: "command_started", name: "compact" });
        try {
          const result = await this.runtime.compactCurrent(options);
          safeUiEvent(options.onUiEvent, { type: "command_finished", name: "compact", ok: true });
          return { kind: "command", result: ephemeral(result.compacted
            ? `Context compacted: ${result.summarizedSteps} step(s) summarized; ${result.retainedSteps} retained; ${result.tokensBefore - result.tokensAfter} estimated tokens freed`
            : "Nothing can be compacted with a meaningful estimated token reduction", result.compacted) };
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
        if ((options.images?.length ?? 0) > 0 && this.model?.acceptsImages !== true) {
          throw new Error("Current model does not accept images. Use /model to pick a vision model.");
        }
        return { kind: "turn", result: await this.runtime.run(input, options) };
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
      await this.dreamer.foregroundStarting();
      const result = await this.inputRouter.route(input, options);
      if (result.kind === "turn") {
        this.dreamer.recordTurn(this.sessionTree.messagesForTurn(result.result.turn.id));
      }
      return result;
    } finally {
      this.inputActive = false;
      this.dreamer.foregroundFinished();
    }
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
      this.rebuildRuntime();
      safeUiEvent(options.onUiEvent, {
        type: "session_changed",
        sessionId: this.sessionTree.activeSession.id,
        liveTipTurnId: this.sessionTree.activeLiveTip,
        reason: "opened",
      });
    }
    return { kind: "command", result };
  }

  async rewindTo(turnIdOrUserEntryId: string) {
    this.sessionTree.requireIdle();
    const candidate = this.sessionTree.resolveRewindCandidate(turnIdOrUserEntryId);
    await this.workspaceState.verify(candidate.workspaceStateId);
    await this.workspaceState.restore(candidate.workspaceStateId);
    const turn = this.sessionTree.projection.turns.get(candidate.turnId);
    if (!turn) throw new Error(`Rewind target disappeared: ${candidate.turnId}`);
    await this.sessionTree.moveLiveTipForRewind(turn.parentTurnId);
    return candidate;
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
    const referenced = new Set<string>();
    for (const turn of this.sessionTree.projection.turns.values()) referenced.add(turn.workspaceStateId);
    for (const stateId of this.workspaceState.referencedStateIds()) referenced.add(stateId);
    return this.workspaceState.cleanup(referenced);
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    const collect = (task: Promise<unknown>) => task.catch((error) => failures.push(error));
    // Start cancellation immediately, but do not make optional background work
    // delay the durable Workspace and Session Tree shutdown sequence.
    const background = [collect(this.dreamer.close()), collect(this.agentTasks.close())];
    await collect(this.workspaceState.settle());
    await collect(this.repository.close());
    await Promise.all(background);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Thread resources failed to close cleanly");
  }
}
