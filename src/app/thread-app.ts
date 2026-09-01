import type { CacheRetention, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import { AgentRuntime, type TurnResult } from "../agent/runtime.js";
import { DEFAULT_SYSTEM_PROMPT } from "../agent/messages.js";
import type { ModelCatalog, ModelClient, ModelDescriptor } from "../agent/model-client.js";
import { ToolRunner } from "../agent/tool-runner.js";
import { TurnRunner } from "../agent/turn-runner.js";
import { buildRewindItems, registerBuiltinCommands } from "../commands/builtins.js";
import { parseCommandLine } from "../commands/parser.js";
import { THREAD_COMMAND_PREFIX, ThreadCommandRouter } from "../commands/registry.js";
import {
  clearDisplayResult,
  CommandRegistry,
  ephemeral,
  viewResult,
  type CommandResult,
} from "../commands/types.js";
import type { ModelState } from "../config/model-state.js";
import { ContextBuilder } from "../context/builder.js";
import { ContextCache } from "../context/cache.js";
import { ContextCompactionService } from "../context/compaction.js";
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

export interface ThreadAppOptions {
  rootPath: string;
  model?: ModelClient;
  modelCatalog?: ModelCatalog;
  thinkingLevel?: ModelThinkingLevel;
  systemPrompt?: string;
  cacheRetention?: CacheRetention;
  skills?: LoadedSkills;
  workspaceExcludedPaths?: readonly string[];
  onModelStateChange?: (state: ModelState) => void;
}

export type InputResult =
  | { kind: "command"; result: CommandResult }
  | { kind: "turn"; result: TurnResult };

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "medium";

export class ThreadApp {
  readonly project: Project;
  readonly rootPath: string;
  readonly sessionTree: SessionTreeService;
  readonly workspaceState: WorkspaceStateService;
  readonly search: SessionSearchService;
  readonly tools = new ToolRegistry();
  readonly commands = new CommandRegistry();
  readonly extensionApi: ExtensionAPI;
  private readonly repository: SessionTreeRepository;
  private readonly contextCache: ContextCache;
  private readonly contextBuilder: ContextBuilder;
  private readonly events = new ExtensionEvents();
  private readonly commandRouter: ThreadCommandRouter;
  private readonly loadedSkills: LoadedSkills;
  private readonly modelCatalog: ModelCatalog | undefined;
  private readonly onModelStateChange: ((state: ModelState) => void) | undefined;
  private readonly configuredSystemPrompt: string | undefined;
  private readonly cacheRetention: CacheRetention | undefined;
  private currentModel: ModelClient | undefined;
  private preferredThinkingLevel: ModelThinkingLevel;
  private currentThinkingLevel: ModelThinkingLevel = "off";
  private runtime: AgentRuntime | undefined;
  private askPresenter: AskPresenter | undefined;
  private inputActive = false;

  private constructor(options: ThreadAppOptions, values: {
    project: Project;
    repository: SessionTreeRepository;
    tree: SessionTreeService;
    workspace: WorkspaceStateService;
    cache: ContextCache;
    builder: ContextBuilder;
    search: SessionSearchService;
    skills: LoadedSkills;
  }) {
    this.project = values.project;
    this.rootPath = values.project.rootPath;
    this.repository = values.repository;
    this.sessionTree = values.tree;
    this.workspaceState = values.workspace;
    this.contextCache = values.cache;
    this.contextBuilder = values.builder;
    this.search = values.search;
    this.loadedSkills = values.skills;
    this.modelCatalog = options.modelCatalog;
    this.onModelStateChange = options.onModelStateChange;
    this.configuredSystemPrompt = options.systemPrompt;
    this.cacheRetention = options.cacheRetention;
    this.preferredThinkingLevel = options.thinkingLevel ?? DEFAULT_THINKING_LEVEL;

    registerBuiltinTools(this.tools);
    this.tools.register(createSessionSearchTool(this.search));
    this.tools.register(createSessionReadTool(this.search));
    if (values.skills.skills.some((skill) => !skill.disableModelInvocation)) {
      this.tools.register(createSkillTool(() => this.loadedSkills.skills));
    }
    this.tools.register(createAskTool());
    registerBuiltinCommands(this.commands);
    this.commandRouter = new ThreadCommandRouter(this.commands);
    this.extensionApi = createExtensionAPI(this.tools, this.commands, this.events);
    this.configureRuntime(options.model);
  }

  static async open(options: ThreadAppOptions): Promise<ThreadApp> {
    const project = await openProject(options.rootPath);
    let repository: SessionTreeRepository | undefined;
    try {
      repository = await SessionTreeRepository.open(project);
      const tree = new SessionTreeService(repository);
      await tree.initialize();
      const workspaceRepository = new WorkspaceStateRepository(project, {
        ...(options.workspaceExcludedPaths ? { excludedPaths: options.workspaceExcludedPaths } : {}),
      });
      await workspaceRepository.initialize();
      const workspace = new WorkspaceStateService(workspaceRepository);
      const cache = new ContextCache(repository.cachePath);
      const builder = new ContextBuilder(tree, cache);
      const search = new SessionSearchService(tree);
      const skills = options.skills ?? await loadSkills();
      return new ThreadApp(options, { project, repository, tree, workspace, cache, builder, search, skills });
    } catch (error) {
      await repository?.close();
      throw error;
    }
  }

  /** Alias retained inside the new API for concise embedding code. */
  get session(): SessionTreeService {
    return this.sessionTree;
  }

  get model(): ModelClient | undefined {
    return this.currentModel;
  }

  get thinkingLevel(): ModelThinkingLevel {
    return this.currentThinkingLevel;
  }

  get supportsThinking(): boolean {
    return this.currentModel?.reasoning === true;
  }

  get availableThinkingLevels(): readonly ModelThinkingLevel[] {
    return this.thinkingLevelsFor(this.currentModel);
  }

  get skills(): readonly Skill[] {
    return this.loadedSkills.skills;
  }

  get skillDiagnostics(): readonly SkillDiagnostic[] {
    return this.loadedSkills.diagnostics;
  }

  setAskPresenter(presenter: AskPresenter | undefined): () => void {
    this.askPresenter = presenter;
    return () => {
      if (this.askPresenter === presenter) this.askPresenter = undefined;
    };
  }

  contextOccupancy(tipTurnId: string | null = this.sessionTree.activeLiveTip): { percent: number; requestTokens: number } | undefined {
    if (!this.currentModel || !this.runtime) return undefined;
    const turns = tipTurnId ? this.sessionTree.pathToTurn(tipTurnId) : [];
    const messages = turns.flatMap((turn) => this.sessionTree.messagesForTurn(turn.id));
    const { requestTokens } = this.runtime.estimateRequestBudget(messages);
    return {
      percent: Math.min(999, Math.round((requestTokens / this.currentModel.contextWindow) * 100)),
      requestTokens,
    };
  }

  cycleThinkingLevel(): ModelThinkingLevel | undefined {
    if (!this.currentModel?.reasoning) return undefined;
    const levels = this.thinkingLevelsFor(this.currentModel);
    const index = levels.indexOf(this.currentThinkingLevel);
    this.preferredThinkingLevel = levels[(index + 1) % levels.length]!;
    this.configureRuntime(this.currentModel);
    this.rememberModelState();
    return this.currentThinkingLevel;
  }

  private thinkingLevelsFor(model: ModelClient | undefined): readonly ModelThinkingLevel[] {
    if (!model?.reasoning) return ["off"];
    const levels = model.supportedThinkingLevels?.filter((level, index, all) => all.indexOf(level) === index);
    return levels?.length ? levels : ["off", "minimal", "low", "medium", "high"];
  }

  private clampThinkingLevel(model: ModelClient | undefined, requested: ModelThinkingLevel): ModelThinkingLevel {
    const available = this.thinkingLevelsFor(model);
    if (available.includes(requested)) return requested;
    const target = THINKING_LEVELS.indexOf(requested);
    return [...available].sort((left, right) =>
      Math.abs(THINKING_LEVELS.indexOf(left) - target) - Math.abs(THINKING_LEVELS.indexOf(right) - target)
    )[0] ?? "off";
  }

  private requestReasoning(): ThinkingLevel | undefined {
    return this.currentThinkingLevel === "off" ? undefined : this.currentThinkingLevel;
  }

  private bindModel(model: ModelClient | undefined): ModelClient | undefined {
    if (!model) return undefined;
    let bound = model;
    const cacheBindable = bound as ModelClient & { withCacheKey?: (key: string) => ModelClient };
    if (cacheBindable.withCacheKey && bound.cacheKey !== this.sessionTree.tree.id) {
      bound = cacheBindable.withCacheKey(this.sessionTree.tree.id);
    }
    const retentionBindable = bound as ModelClient & {
      withCacheRetention?: (retention: CacheRetention | undefined) => ModelClient;
    };
    if (retentionBindable.withCacheRetention && bound.cacheRetention !== this.cacheRetention) {
      bound = retentionBindable.withCacheRetention(this.cacheRetention);
    }
    return bound;
  }

  private configureRuntime(model: ModelClient | undefined): void {
    this.currentModel = this.bindModel(model);
    this.currentThinkingLevel = this.clampThinkingLevel(this.currentModel, this.preferredThinkingLevel);
    if (!this.currentModel) {
      this.runtime = undefined;
      return;
    }
    const reasoning = this.requestReasoning();
    const skills = formatSkillsSection(this.loadedSkills.skills);
    const systemPrompt = [this.configuredSystemPrompt ?? DEFAULT_SYSTEM_PROMPT, skills].filter(Boolean).join("\n\n");
    const compaction = new ContextCompactionService(
      this.contextBuilder,
      this.contextCache,
      this.currentModel,
      reasoning,
    );
    const toolRunner = new ToolRunner(
      this.rootPath,
      this.sessionTree,
      this.tools,
      this.events,
      () => this.askPresenter,
    );
    const maxOutputTokens = Math.min(
      this.currentModel.maxOutputTokens,
      16_384,
      Math.max(1_024, Math.floor(this.currentModel.contextWindow * 0.2)),
    );
    const runner = new TurnRunner(
      this.currentModel,
      this.sessionTree,
      this.contextBuilder,
      compaction,
      this.tools,
      toolRunner,
      this.events,
      systemPrompt,
      maxOutputTokens,
      reasoning,
    );
    this.runtime = new AgentRuntime(this.sessionTree, this.workspaceState, runner, this.events);
  }

  private rememberModelState(): void {
    const model = this.currentModel;
    this.onModelStateChange?.({
      ...(model ? { model: { provider: model.providerId, id: model.modelId } } : {}),
      thinkingLevel: this.preferredThinkingLevel,
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
    const content = this.currentModel
      ? `Current model: ${this.currentModel.providerId}/${this.currentModel.modelId}\nContext window: ${this.currentModel.contextWindow.toLocaleString("en-US")} tokens\nThinking level: ${this.currentThinkingLevel}`
      : "No model selected. Use /model list and /model <provider>/<model>.";
    if (!this.modelCatalog) return ephemeral(content);
    return viewResult(content, {
      type: "model_picker",
      models,
      currentProviderId: this.currentModel?.providerId,
      currentModelId: this.currentModel?.modelId,
      scope,
    });
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
    const previous = this.currentModel ? `${this.currentModel.providerId}/${this.currentModel.modelId}` : "none";
    this.configureRuntime(this.modelCatalog.createClient(providerId, modelId));
    this.rememberModelState();
    return ephemeral(`Switched model from ${previous} to ${providerId}/${modelId}`, true);
  }

  private describeSkills(): string {
    return [
      `skills directory: ${skillsDirectory()}`,
      ...this.skills.map((skill) => `- ${skill.name}: ${skill.description}`),
      ...this.skillDiagnostics.map((item) => `${item.kind}: ${item.message} (${item.path})`),
    ].join("\n");
  }

  async handleInput(
    input: string,
    options: { signal: AbortSignal; onTextDelta?: (delta: string) => void; onUiEvent?: UiEventSink },
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
    options: { signal: AbortSignal; onTextDelta?: (delta: string) => void; onUiEvent?: UiEventSink },
  ): Promise<InputResult> {
    const trimmed = input.trim();
    if (trimmed === "/new") {
      safeUiEvent(options.onUiEvent, { type: "command_started", name: "new" });
      try {
        options.signal.throwIfAborted();
        const session = await new NewSession(this.sessionTree).execute();
        safeUiEvent(options.onUiEvent, {
          type: "session_changed",
          sessionId: session.id,
          liveTipTurnId: null,
          reason: "new",
        });
        safeUiEvent(options.onUiEvent, { type: "command_finished", name: "new", ok: true });
        return { kind: "command", result: ephemeral(`Created empty Session ${session.id} from Root; workspace unchanged`, true) };
      } catch (error) {
        safeUiEvent(options.onUiEvent, { type: "command_finished", name: "new", ok: false });
        throw error;
      }
    }
    if (trimmed.startsWith("/new ")) throw new Error("Usage: /new");
    if (trimmed === "/clear") return { kind: "command", result: clearDisplayResult() };
    if (trimmed === "/model" || trimmed.startsWith("/model ")) {
      return { kind: "command", result: this.handleModelCommand(parseCommandLine(trimmed.slice(6).trim())) };
    }
    if (trimmed === "/skill" || trimmed.startsWith("/skill ")) {
      const rest = trimmed.slice(6).trim();
      if (!rest) return { kind: "command", result: ephemeral(this.describeSkills()) };
      const separator = rest.search(/\s/);
      const name = separator < 0 ? rest : rest.slice(0, separator);
      const extra = separator < 0 ? undefined : rest.slice(separator + 1).trim() || undefined;
      const skill = this.skills.find((item) => item.name === name);
      if (!skill) throw new Error(`Unknown skill: ${name}`);
      if (!this.runtime) throw new Error("/skill requires a configured model");
      return { kind: "turn", result: await new RunTurn(this.runtime).execute(formatSkillInvocation(skill, extra), options) };
    }
    if (trimmed === "/compact") {
      if (!this.runtime) throw new Error("/compact requires a configured model");
      safeUiEvent(options.onUiEvent, { type: "command_started", name: "compact" });
      try {
        const result = await new Compact(this.runtime).execute(options);
        safeUiEvent(options.onUiEvent, { type: "command_finished", name: "compact", ok: true });
        return { kind: "command", result: ephemeral(result.compacted
          ? `Context cache regenerated: ${result.summarizedTurns} turn(s) summarized; ${result.retainedTurns} retained`
          : "Nothing to compact; too few completed turns", result.compacted) };
      } catch (error) {
        safeUiEvent(options.onUiEvent, { type: "command_finished", name: "compact", ok: false });
        throw error;
      }
    }
    if (trimmed.startsWith("/compact ")) throw new Error("Usage: /compact");
    if (trimmed === "/session" || trimmed.startsWith("/session ")) {
      const args = parseCommandLine(trimmed.slice(8).trim());
      const routed = args.length === 0 ? "/thread sessions" : `/thread open ${args.join(" ")}`;
      return this.routeThreadCommand(routed, options);
    }
    if (trimmed === "/rewind" || trimmed.startsWith("/rewind ")) {
      const args = parseCommandLine(trimmed.slice(7).trim());
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
    }
    if (trimmed === THREAD_COMMAND_PREFIX || trimmed.startsWith(`${THREAD_COMMAND_PREFIX} `)) {
      return this.routeThreadCommand(trimmed, options);
    }
    if (!this.runtime) {
      throw new Error("No model configured. Use /model list and /model <provider>/<model>.");
    }
    return { kind: "turn", result: await new RunTurn(this.runtime).execute(input, options) };
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
    return new Rewind(this.sessionTree, this.workspaceState, this.contextCache).execute(turnIdOrUserEntryId);
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

  close(): Promise<void> {
    return this.repository.close();
  }
}
