import path from "node:path";
import type { ModelThinkingLevel, CacheRetention, ThinkingLevel } from "@earendil-works/pi-ai";
import { clearDisplayResult, ephemeral, viewResult, type CommandResult } from "./commands/types.js";
import { buildHistoryItems, buildSquashItems, registerBuiltinCommands, rewindCommand } from "./commands/builtins.js";
import { parseCommandLine } from "./commands/parser.js";
import { THREAD_COMMAND_PREFIX, ThreadCommandRouter } from "./commands/registry.js";
import { CommandRegistry } from "./commands/types.js";
import { AgentLoop, DEFAULT_SYSTEM_PROMPT, type TurnResult } from "./agent/loop.js";
import type { ModelCatalog, ModelClient, ModelDescriptor } from "./agent/model-client.js";
import { ModelSemanticRunner } from "./agent/semantic-runner.js";
import { createExtensionAPI, type ExtensionAPI } from "./extensions/api.js";
import { ExtensionEvents } from "./extensions/events.js";
import { DerivedCache } from "./persistence/cache.js";
import type { ModelState } from "./config/model-state.js";
import { CapsuleService } from "./revisions/capsule-service.js";
import { MergeService } from "./revisions/merge-service.js";
import { VersionService } from "./revisions/version-service.js";
import { SessionLogStore } from "./session/log-store.js";
import { SessionRecallService } from "./session/recall.js";
import { SessionService } from "./session/service.js";
import {
  formatSkillsSection,
  loadSkills,
  skillsDirectory,
  type LoadedSkills,
  type Skill,
  type SkillDiagnostic,
} from "./skills/loader.js";
import { registerBuiltinTools } from "./tools/builtins.js";
import { createSkillTool, formatSkillInvocation } from "./tools/skill.js";
import { createSessionReadTool, createSessionRecallTool } from "./tools/session-recall.js";
import { ToolRegistry } from "./tools/types.js";
import { safeUiEvent, type UiEventSink } from "./ui/events.js";
import { discoverGitWorkspace, type GitWorkspace } from "./workspace/discovery.js";
import { SidecarWorkspaceStore } from "./workspace/sidecar-store.js";
import { CONTEXT_ESTIMATOR_VERSION } from "./utils/estimate.js";

export interface ThreadAppOptions {
  rootPath: string;
  model?: ModelClient;
  modelCatalog?: ModelCatalog;
  thinkingLevel?: ModelThinkingLevel;
  systemPrompt?: string;
  /**
   * Prompt-cache lifetime applied to every model request. Left unset, the
   * provider default applies (Anthropic 5-minute ephemeral); `long` is worth
   * enabling only when idle gaps between turns routinely exceed that window,
   * because it raises the cache-write price.
   */
  cacheRetention?: CacheRetention;
  /**
   * Pre-discovered skills, bypassing the user-level scan. Embedders supply this to
   * control what a session advertises; the CLI leaves it unset.
   */
  skills?: LoadedSkills;
  /**
   * Persists interactive `/model` and thinking-level choices so the next start
   * reuses them. Omitted by embedders and tests, which then keep the current
   * process-only behaviour.
   */
  onModelStateChange?: (state: ModelState) => void;
}

export type InputResult =
  | { kind: "command"; result: CommandResult }
  | { kind: "turn"; result: TurnResult };

interface SessionRuntime {
  log: SessionLogStore;
  session: SessionService;
  versions: VersionService;
  cache: DerivedCache;
  capsules: CapsuleService;
  merge: MergeService;
  loop: AgentLoop | undefined;
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "medium";

/**
 * Version-system briefing carried by the `/thread diff` prompt. It used to live in
 * the system prompt, but the agent needs it only when a version comparison is
 * actually requested, and the system prompt sits in front of every request where
 * a byte of drift costs the whole prompt cache. Delivering it as part of the
 * wrapped user message keeps the agent unaware of the version machinery the rest
 * of the time and leaves the cached prefix untouched.
 */
function versionBriefing(log: SessionLogStore, versions: VersionService): string[] {
  return [
    "This Session Tree is versioned: every durable state change is a checkpoint pairing a full",
    "workspace snapshot with a conversation-context head. Thread commits name checkpoints; branches",
    "move between them. All version data is append-only and readable with your normal tools:",
    `- Session log: ${log.eventsPath} — one JSON object per line. Query it with grep, never by`,
    "  reading it whole; it grows unboundedly. Events may nest inside `batch` records",
    '  (`{"type":"batch","events":[...]}`), so unwrap matched lines by parsing JSON rather than',
    '  slicing text. Grep the quoted type string (e.g. `"type":"thread_commit_created"`): bare event',
    "  names also occur inside stored conversation messages and match falsely. Key events:",
    "  `thread_commit_created` (commit.checkpointId), `checkpoint_created` (checkpoint.id,",
    "  .parentCheckpointIds, .workspaceTreeOid, .sessionHeadId, .reason), `branch_moved` (branchName,",
    "  newCheckpointId). Refs resolve as: HEAD, a branch name (its latest branch_moved target), or a",
    "  thread commit / checkpoint id or unambiguous prefix.",
    `- Sidecar object store: ${versions.workspace.storeGitDir} — an independent Git object database`,
    "  holding every snapshot. Read it with git, e.g.",
    `  git --git-dir=${versions.workspace.storeGitDir} diff-tree -r --stat <from-tree> <to-tree>.`,
    `- Context Capsules: ${path.join(log.cacheDir, "capsules", "<checkpointId>.json")} — a lossy`,
    "  summary of a committed checkpoint's working context. Only committed endpoints have one; the",
    "  current state never does. Read one when you need context details your own memory no longer",
    "  holds, and treat it as a lossy cache rather than a source of truth.",
    "- The most recent `checkpoint_created` line is this turn's base: a mechanical snapshot of the",
    "  workspace as this turn began. Diff against that tree instead of approximating by hand.",
    "These paths are read-only here: never write to the session log or the sidecar store, and never",
    "run git commands that create objects, refs or commits in it. If a path lies outside the",
    "workspace root, the read/grep/list tools cannot reach it — use bash.",
  ];
}

/**
 * Skills advertised to the model, or nothing when none are installed. Returned as
 * an array so an empty skill set leaves the prompt byte-identical to a build
 * without the feature, instead of appending a stray blank section.
 */
function skillsSystemPromptSection(skills: readonly Skill[]): string[] | undefined {
  const section = formatSkillsSection(skills);
  return section ? [section] : undefined;
}

export class ThreadApp {
  readonly extensionApi: ExtensionAPI;
  readonly rootPath: string;
  readonly tools: ToolRegistry;
  readonly commands: CommandRegistry;
  readonly workspace: GitWorkspace;
  private runtime: SessionRuntime;
  private readonly events: ExtensionEvents;
  private readonly modelCatalog: ModelCatalog | undefined;
  private readonly onModelStateChange: ((state: ModelState) => void) | undefined;
  private readonly systemPrompt: string | undefined;
  private readonly cacheRetention: CacheRetention | undefined;
  private readonly commandRouter: ThreadCommandRouter;
  private readonly loadedSkills: LoadedSkills;
  private currentModel: ModelClient | undefined;
  private preferredThinkingLevel: ModelThinkingLevel;
  private currentThinkingLevel: ModelThinkingLevel = "off";
  private activeInputCount = 0;
  private newBranchTransitioning = false;

  private constructor(
    options: ThreadAppOptions,
    workspace: GitWorkspace,
    log: SessionLogStore,
    session: SessionService,
    versions: VersionService,
    skills: LoadedSkills,
  ) {
    this.rootPath = workspace.rootPath;
    this.workspace = workspace;
    this.events = new ExtensionEvents();
    this.modelCatalog = options.modelCatalog;
    this.onModelStateChange = options.onModelStateChange;
    this.systemPrompt = options.systemPrompt;
    this.cacheRetention = options.cacheRetention;
    this.loadedSkills = skills;
    this.tools = new ToolRegistry();
    registerBuiltinTools(this.tools);
    /* Registered here, not in buildRuntime: the SessionService outlives every runtime
     * rebuild and re-registering a tool name throws. */
    const recall = new SessionRecallService(session);
    this.tools.register(createSessionRecallTool(recall));
    this.tools.register(createSessionReadTool(recall));
    if (skills.skills.some((skill) => !skill.disableModelInvocation)) {
      this.tools.register(createSkillTool(() => this.loadedSkills.skills));
    }
    this.commands = new CommandRegistry();
    registerBuiltinCommands(this.commands);
    this.commandRouter = new ThreadCommandRouter(this.commands);
    this.extensionApi = createExtensionAPI(this.tools, this.commands, this.events);
    this.preferredThinkingLevel = options.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
    this.currentModel = this.bindCacheOptions(options.model, log.sessionId);
    this.currentThinkingLevel = this.clampThinkingLevel(options.model, this.preferredThinkingLevel);
    this.runtime = this.buildRuntime(log, session, versions);
  }

  static async open(options: ThreadAppOptions): Promise<ThreadApp> {
    const workspace = await discoverGitWorkspace(path.resolve(options.rootPath));
    let log: SessionLogStore | undefined;
    try {
      log = await SessionLogStore.open({
        rootPath: workspace.rootPath,
        sidecarRoot: workspace.sidecarRoot,
      });
      const session = new SessionService(log);
      const sidecar = new SidecarWorkspaceStore({ workspace, sessionId: log.sessionId });
      const versions = new VersionService(session, sidecar);
      await versions.initialize(workspace.rootPath);
      /* Discovered once here, never rescanned: the advertised skills are folded
       * into the system prompt, which sits at the very front of every request and
       * must stay byte-identical for the prompt cache to keep hitting. */
      const skills = options.skills ?? await loadSkills();
      return new ThreadApp(options, workspace, log, session, versions, skills);
    } catch (error) {
      await log?.close();
      throw error;
    }
  }

  /** Skills discovered at startup, including those hidden from the model. */
  get skills(): readonly Skill[] {
    return this.loadedSkills.skills;
  }

  /** Warnings raised while loading skills; empty when every skill parsed cleanly. */
  get skillDiagnostics(): readonly SkillDiagnostic[] {
    return this.loadedSkills.diagnostics;
  }

  get session(): SessionService {
    return this.runtime.session;
  }

  get versions(): VersionService {
    return this.runtime.versions;
  }

  get capsules(): CapsuleService {
    return this.runtime.capsules;
  }

  get merge(): MergeService {
    return this.runtime.merge;
  }

  private get loop(): AgentLoop | undefined {
    return this.runtime.loop;
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

  /**
   * Share of the model's context window the next request would occupy, measured
   * the same way the turn loop measures it so display and the compaction trigger
   * agree. Without a model, or before a loop exists, there is nothing to report.
   */
  contextOccupancy(sessionHeadId: string | null): { percent: number; requestTokens: number } | undefined {
    const model = this.currentModel;
    const loop = this.loop;
    if (!model || !loop) return undefined;
    const messages = this.session.buildContext(sessionHeadId).messages;
    const { requestTokens } = loop.estimateRequestBudget(messages);
    return {
      percent: Math.min(999, Math.round((requestTokens / model.contextWindow) * 100)),
      requestTokens,
    };
  }

  get availableThinkingLevels(): readonly ModelThinkingLevel[] {
    return this.thinkingLevelsFor(this.currentModel);
  }

  cycleThinkingLevel(): ModelThinkingLevel | undefined {
    if (!this.currentModel?.reasoning) return undefined;
    const levels = this.thinkingLevelsFor(this.currentModel);
    const currentIndex = levels.indexOf(this.currentThinkingLevel);
    this.preferredThinkingLevel = levels[(currentIndex + 1) % levels.length]!;
    this.configureRuntime(this.currentModel);
    this.rememberModelState();
    return this.currentThinkingLevel;
  }

  /**
   * Reports the current selection so the host can persist it. The preferred
   * level is recorded rather than the clamped one, so a model that cannot reach
   * the user's choice does not permanently narrow it.
   */
  private rememberModelState(): void {
    if (!this.onModelStateChange) return;
    const model = this.currentModel;
    this.onModelStateChange({
      ...(model ? { model: { provider: model.providerId, id: model.modelId } } : {}),
      thinkingLevel: this.preferredThinkingLevel,
    });
  }

  private thinkingLevelsFor(model: ModelClient | undefined): readonly ModelThinkingLevel[] {
    if (!model?.reasoning) return ["off"];
    const levels = model.supportedThinkingLevels?.filter((level, index, values) => values.indexOf(level) === index);
    return levels && levels.length > 0 ? levels : ["off", "minimal", "low", "medium", "high"];
  }

  private clampThinkingLevel(model: ModelClient | undefined, requested: ModelThinkingLevel): ModelThinkingLevel {
    const available = this.thinkingLevelsFor(model);
    if (available.includes(requested)) return requested;
    const requestedIndex = THINKING_LEVELS.indexOf(requested);
    for (let index = requestedIndex; index < THINKING_LEVELS.length; index++) {
      const candidate = THINKING_LEVELS[index]!;
      if (available.includes(candidate)) return candidate;
    }
    for (let index = requestedIndex - 1; index >= 0; index--) {
      const candidate = THINKING_LEVELS[index]!;
      if (available.includes(candidate)) return candidate;
    }
    return available[0] ?? "off";
  }

  private requestReasoning(): ThinkingLevel | undefined {
    return this.currentThinkingLevel === "off" ? undefined : this.currentThinkingLevel;
  }

  /**
   * Binds a model client to this Session Tree's prompt-cache partition and the
   * configured retention. One key per tree keeps the live turn, its squash forks
   * and the capsule/merge helpers in a single shard; without it those paths fall
   * back to different defaults and a provider that keys its cache on the value
   * re-bills the shared prefix.
   */
  private bindCacheOptions(model: ModelClient | undefined, sessionId: string): ModelClient | undefined {
    if (!model) return undefined;
    const retention = this.cacheRetention;
    if (model.cacheKey === sessionId && model.cacheRetention === retention) return model;
    const rebindable = model as ModelClient & {
      withCacheKey?: (key: string) => ModelClient;
      withCacheRetention?: (value: CacheRetention | undefined) => ModelClient;
    };
    let bound = model;
    if (typeof rebindable.withCacheKey === "function" && bound.cacheKey !== sessionId) {
      bound = rebindable.withCacheKey(sessionId);
    }
    const retentionBindable = bound as ModelClient & {
      withCacheRetention?: (value: CacheRetention | undefined) => ModelClient;
    };
    if (typeof retentionBindable.withCacheRetention === "function" && bound.cacheRetention !== retention) {
      bound = retentionBindable.withCacheRetention(retention);
    }
    return bound;
  }

  /**
   * Skill inventory including entries hidden from the model, plus any load
   * diagnostics. A skill that failed validation disappears silently otherwise,
   * which is the hardest failure to notice.
   */
  private describeSkills(): string {
    const lines: string[] = [`skills directory: ${skillsDirectory()}`];
    if (this.loadedSkills.skills.length === 0) lines.push("(no skills installed)");
    for (const skill of this.loadedSkills.skills) {
      const flag = skill.disableModelInvocation ? " [manual only]" : "";
      lines.push(`- ${skill.name}${flag}: ${skill.description}`);
    }
    for (const diagnostic of this.loadedSkills.diagnostics) {
      lines.push(`${diagnostic.kind}: ${diagnostic.message} (${diagnostic.path})`);
    }
    return lines.join("\n");
  }

  private configureRuntime(model: ModelClient | undefined): void {
    this.currentModel = this.bindCacheOptions(model, this.runtime.log.sessionId);
    this.currentThinkingLevel = this.clampThinkingLevel(model, this.preferredThinkingLevel);
    this.runtime = this.buildRuntime(this.runtime.log, this.runtime.session, this.runtime.versions);
  }

  private buildRuntime(
    log: SessionLogStore,
    session: SessionService,
    versions: VersionService,
  ): SessionRuntime {
    const cache = new DerivedCache(log.cacheDir);
    // Evaluated lazily per commit, by which time this.runtime.loop is in place,
    // so the recorded cost matches what the footer and the compaction trigger use.
    versions.setContextCostProvider(this.currentModel
      ? () => {
          const occupancy = this.contextOccupancy(versions.head.sessionHeadId);
          if (!occupancy) throw new Error("Thread commit requires a configured model to record context cost");
          return {
            percent: occupancy.percent,
            estimatedTokens: occupancy.requestTokens,
            contextWindow: this.currentModel!.contextWindow,
            providerId: this.currentModel!.providerId,
            modelId: this.currentModel!.modelId,
            estimatorVersion: CONTEXT_ESTIMATOR_VERSION,
          };
        }
      : undefined);
    const reasoning = this.requestReasoning();
    const semantic = this.currentModel ? new ModelSemanticRunner(this.currentModel, reasoning) : undefined;
    const capsules = new CapsuleService(session, cache, semantic);
    const merge = new MergeService(versions, session, capsules, semantic);
    const systemPrompt = [
      this.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      ...(skillsSystemPromptSection(this.loadedSkills.skills) ?? []),
    ].join("\n\n");
    const loop = this.currentModel
      ? new AgentLoop(
          this.rootPath,
          this.currentModel,
          session,
          versions,
          this.tools,
          this.events,
          {
            systemPrompt,
            ...(reasoning ? { reasoning } : {}),
          },
        )
      : undefined;
    return { log, session, versions, cache, capsules, merge, loop };
  }

  private modelPickerModels(scope: "configured" | "all"): ModelDescriptor[] {
    if (!this.modelCatalog) return [];
    const models = scope === "all"
      ? (this.modelCatalog.listAll?.() ?? this.modelCatalog.list())
      : this.modelCatalog.list();
    const current = this.currentModel;
    if (!current || models.some((model) =>
      model.providerId === current.providerId && model.modelId === current.modelId
    )) return models;
    const descriptor = (this.modelCatalog.listAll?.(current.providerId) ?? this.modelCatalog.list(current.providerId))
      .find((model) => model.providerId === current.providerId && model.modelId === current.modelId) ?? {
        providerId: current.providerId,
        modelId: current.modelId,
        name: current.modelId,
        contextWindow: current.contextWindow,
        maxOutputTokens: current.maxOutputTokens,
        reasoning: current.reasoning ?? false,
      };
    return [...models, descriptor].sort((left, right) =>
      left.providerId.localeCompare(right.providerId) || left.modelId.localeCompare(right.modelId),
    );
  }

  private modelStatus(scope: "configured" | "all" = "configured"): CommandResult {
    const models = this.modelPickerModels(scope);
    const scopeLine = scope === "all"
      ? `Complete catalog: ${models.length.toLocaleString("en-US")} model(s).`
      : `Configured/current choices: ${models.length.toLocaleString("en-US")} model(s). Use /model all for the complete catalog.`;
    const content = this.currentModel
      ? [
        `Current model: ${this.currentModel.providerId}/${this.currentModel.modelId}`,
        `Context window: ${this.currentModel.contextWindow.toLocaleString("en-US")} tokens`,
        `Maximum output: ${this.currentModel.maxOutputTokens.toLocaleString("en-US")} tokens`,
        ...(this.supportsThinking
          ? [`Thinking level: ${this.currentThinkingLevel} (Shift+Tab to cycle)`]
          : []),
        scopeLine,
        "Use /model list [provider] or /model <provider>/<model> to switch.",
      ].join("\n")
      : [
        "No model selected.",
        scopeLine,
        "Use /model list [provider] and /model <provider>/<model> to select one.",
      ].join("\n");
    if (!this.modelCatalog) return ephemeral(content);
    return viewResult(content, {
      type: "model_picker",
      models,
      currentProviderId: this.currentModel?.providerId,
      currentModelId: this.currentModel?.modelId,
      scope,
    });
  }

  private modelList(providerId?: string): CommandResult {
    if (!this.modelCatalog) {
      throw new Error("Model listing is unavailable because this application was opened without a model catalog");
    }
    const models = providerId
      ? (this.modelCatalog.listAll?.(providerId) ?? this.modelCatalog.list(providerId))
      : this.modelPickerModels("configured");
    if (models.length === 0) {
      throw new Error(
        providerId
          ? `No models found for provider ${providerId}`
          : "No configured models are available. Use /model all to browse the complete catalog.",
      );
    }
    return ephemeral([
      `${providerId ? `Available models for ${providerId}` : "Configured/current models"} (${models.length}):`,
      ...models.map((model) => this.formatModel(model)),
    ].join("\n"));
  }

  private formatModel(model: ModelDescriptor): string {
    const current = this.currentModel?.providerId === model.providerId && this.currentModel.modelId === model.modelId;
    const detail = [
      model.name !== model.modelId ? model.name : undefined,
      `${model.contextWindow.toLocaleString("en-US")} context`,
      model.reasoning ? "reasoning" : undefined,
    ].filter((value): value is string => value !== undefined).join(", ");
    return `${current ? "*" : " "} ${model.providerId}/${model.modelId} — ${detail}`;
  }

  private handleModelCommand(args: string[]): CommandResult {
    if (args.length === 0) return this.modelStatus();
    if (args[0] === "all") {
      if (args.length !== 1) throw new Error("Usage: /model all");
      if (!this.modelCatalog) {
        throw new Error("Full model listing is unavailable because this application was opened without a model catalog");
      }
      return this.modelStatus("all");
    }
    if (args[0] === "list") {
      if (args.length > 2) throw new Error("Usage: /model list [provider]");
      return this.modelList(args[1]);
    }
    let providerId: string;
    let modelId: string;
    if (args.length === 1) {
      const separator = args[0]!.indexOf("/");
      if (separator <= 0 || separator === args[0]!.length - 1) {
        throw new Error("Usage: /model <provider>/<model> or /model <provider> <model>");
      }
      providerId = args[0]!.slice(0, separator);
      modelId = args[0]!.slice(separator + 1);
    } else if (args.length === 2) {
      [providerId, modelId] = args as [string, string];
    } else {
      throw new Error("Usage: /model <provider>/<model> or /model <provider> <model>");
    }
    if (this.currentModel?.providerId === providerId && this.currentModel.modelId === modelId) {
      return ephemeral(`Already using ${providerId}/${modelId}`);
    }
    if (!this.modelCatalog) {
      throw new Error("Model switching is unavailable because this application was opened without a model catalog");
    }
    const previous = this.currentModel
      ? `${this.currentModel.providerId}/${this.currentModel.modelId}`
      : "no model";
    const selected = this.modelCatalog.createClient(providerId, modelId);
    this.configureRuntime(selected);
    this.rememberModelState();
    return ephemeral(`Switched model from ${previous} to ${providerId}/${modelId}`, true);
  }

  async handleInput(
    input: string,
    options: { signal: AbortSignal; onTextDelta?: (delta: string) => void; onUiEvent?: UiEventSink },
  ): Promise<InputResult> {
    const trimmed = input.trim();
    const transition = trimmed === "/new";
    if (this.newBranchTransitioning) throw new Error("A /new branch transition is already running");
    if (transition && this.activeInputCount > 0) {
      throw new Error("Wait for the active turn or command before creating a new root branch");
    }
    this.activeInputCount++;
    if (transition) this.newBranchTransitioning = true;
    try {
      return await this.handleInputInner(input, options);
    } finally {
      this.activeInputCount--;
      if (transition) this.newBranchTransitioning = false;
    }
  }

  private async handleInputInner(
    input: string,
    options: { signal: AbortSignal; onTextDelta?: (delta: string) => void; onUiEvent?: UiEventSink },
  ): Promise<InputResult> {
    const isNewCommand = input === "/new" || (input.startsWith("/new") && /\s/.test(input[4] ?? ""));
    if (isNewCommand) {
      if (input.trim() !== "/new") throw new Error("Usage: /new");
      safeUiEvent(options.onUiEvent, { type: "command_started", name: "new" });
      try {
        options.signal.throwIfAborted();
        const created = await this.versions.createNewBranch();
        safeUiEvent(options.onUiEvent, {
          type: "head_changed",
          branch: created.branch.name,
          checkpointId: created.checkpoint.id,
          reason: "new",
        });
        safeUiEvent(options.onUiEvent, { type: "command_finished", name: "new", ok: true });
        return {
          kind: "command",
          result: ephemeral(
            `Created ${created.branch.name} from the Session Tree root with the current workspace and empty context`,
            true,
          ),
        };
      } catch (error) {
        safeUiEvent(options.onUiEvent, { type: "command_finished", name: "new", ok: false });
        throw error;
      }
    }
    const commandContext = {
      rootPath: this.rootPath,
      versions: this.versions,
      merge: this.merge,
      capsules: this.capsules,
      model: this.currentModel,
      skills: this.loadedSkills.skills,
      skillDiagnostics: this.loadedSkills.diagnostics,
      signal: options.signal,
    };
    const isClearCommand = input === "/clear" || (input.startsWith("/clear") && /\s/.test(input[6] ?? ""));
    if (isClearCommand) {
      if (input.trim() !== "/clear") throw new Error("Usage: /clear");
      safeUiEvent(options.onUiEvent, { type: "command_started", name: "clear" });
      safeUiEvent(options.onUiEvent, { type: "command_finished", name: "clear", ok: true });
      return { kind: "command", result: clearDisplayResult() };
    }
    const isModelCommand = input === "/model" || (input.startsWith("/model") && /\s/.test(input[6] ?? ""));
    if (isModelCommand) {
      safeUiEvent(options.onUiEvent, { type: "command_started", name: "model" });
      try {
        options.signal.throwIfAborted();
        const result = this.handleModelCommand(parseCommandLine(input.slice(6).trim()));
        safeUiEvent(options.onUiEvent, { type: "command_finished", name: "model", ok: true });
        return { kind: "command", result };
      } catch (error) {
        safeUiEvent(options.onUiEvent, { type: "command_finished", name: "model", ok: false });
        throw error;
      }
    }
    /* /skill is intercepted here rather than registered as a thread command: with
     * an argument it expands into an ordinary user turn, so what the log records is
     * the skill text the model actually received, not the bare command. */
    const isSkillCommand = input === "/skill" || (input.startsWith("/skill") && /\s/.test(input[6] ?? ""));
    if (isSkillCommand) {
      const rest = input.slice("/skill".length).trim();
      if (!rest) {
        safeUiEvent(options.onUiEvent, { type: "command_started", name: "skill" });
        safeUiEvent(options.onUiEvent, { type: "command_finished", name: "skill", ok: true });
        return { kind: "command", result: ephemeral(this.describeSkills()) };
      }
      const separator = rest.search(/\s/);
      const name = separator === -1 ? rest : rest.slice(0, separator);
      const extra = separator === -1 ? "" : rest.slice(separator + 1).trim();
      const skill = this.loadedSkills.skills.find((candidate) => candidate.name === name);
      if (!skill) {
        const names = this.loadedSkills.skills.map((candidate) => candidate.name).join(", ");
        throw new Error(`Unknown skill: ${name}. Available skills: ${names || "(none)"}`);
      }
      if (!this.loop) throw new Error("/skill requires a configured model");
      return {
        kind: "turn",
        result: await this.loop.run(formatSkillInvocation(skill, extra || undefined), options),
      };
    }
    const isCompactCommand = input === "/compact" || (input.startsWith("/compact") && /\s/.test(input[8] ?? ""));
    if (isCompactCommand) {
      if (input.trim() !== "/compact") throw new Error("Usage: /compact");
      if (!this.loop) throw new Error("/compact requires a configured model");
      safeUiEvent(options.onUiEvent, { type: "command_started", name: "compact" });
      try {
        const compacted = await this.loop.compactCurrent({
          signal: options.signal,
          ...(options.onUiEvent ? { onUiEvent: options.onUiEvent } : {}),
        });
        safeUiEvent(options.onUiEvent, { type: "command_finished", name: "compact", ok: true });
        if (!compacted.compacted) {
          return {
            kind: "command",
            result: ephemeral("Nothing to compact; the current context only contains the retained interaction tail"),
          };
        }
        safeUiEvent(options.onUiEvent, {
          type: "head_changed",
          branch: this.versions.currentBranch.name,
          checkpointId: compacted.checkpointId!,
          reason: "command",
        });
        return {
          kind: "command",
          result: ephemeral(
            `Context compacted: ${compacted.summarizedMessages} message(s) summarized, ${compacted.retainedMessages} message(s) retained, ${compacted.modelCalls} model call(s); checkpoint ${compacted.checkpointId}`,
            true,
          ),
        };
      } catch (error) {
        safeUiEvent(options.onUiEvent, { type: "command_finished", name: "compact", ok: false });
        throw error;
      }
    }
    /* /thread diff is captured here and re-issued to the agent as a wrapped
     * user message instead of routing to a dedicated diff service: the agent
     * reads the version data itself with its atomic tools, briefed by the
     * prompt below, and its reply is an ordinary append-only turn. Persisting
     * the wrapped prompt — not the bare command — keeps the canonical log
     * faithful to what the model actually saw. */
    const isThreadDiffCommand = input === "/thread diff" ||
      (input.startsWith("/thread diff") && /\s/.test(input["/thread diff".length] ?? ""));
    if (isThreadDiffCommand) {
      const args = parseCommandLine(input.slice("/thread diff".length).trim());
      const factsOnly = args.includes("--facts");
      const refs = args.filter((arg) => arg !== "--facts");
      if (refs.length !== 0 && refs.length !== 2) {
        throw new Error("Usage: /thread diff [<from> <to>] [--facts]");
      }
      if (!this.loop) {
        throw new Error("/thread diff runs as an agent turn, which requires a configured model");
      }
      const command = `/thread diff${refs.length > 0 ? ` ${refs.join(" ")}` : ""}${factsOnly ? " --facts" : ""}`;
      const prompt = [
        "The user ran the slash command:",
        "",
        `    ${command}`,
        "",
        ...versionBriefing(this.runtime.log, this.versions),
        "",
        ...(refs.length === 0
          ? [
            "Compare the most recent thread commit with the current state of this session.",
            "Workspace: resolve the most recent thread commit and this turn's base checkpoint (the",
            "latest checkpoint_created event), then diff their workspace trees through the sidecar",
            "object store.",
            "Context: summarize how the working context evolved since that commit, from your own",
            "memory of this session.",
          ]
          : [
            `Compare thread version ${refs[0]} with thread version ${refs[1]}.`,
            "Resolve both refs yourself (branch name, thread commit id or prefix, or checkpoint id or",
            "prefix), diff their workspace trees through the sidecar object store, and compare their",
            "context heads by reading the session log.",
          ]),
        ...(factsOnly
          ? [
            "Report only deterministic facts — changed files with statuses and line counts, and which",
            "entries lie between the two context heads. Do not interpret or speculate.",
          ]
          : ["Keep mechanical facts separate from your interpretation."]),
      ].join("\n");
      return {
        kind: "turn",
        result: await this.loop.run(prompt, {
          signal: options.signal,
          ...(options.onTextDelta ? { onTextDelta: options.onTextDelta } : {}),
          ...(options.onUiEvent ? { onUiEvent: options.onUiEvent } : {}),
        }),
      };
    }
    const isThreadSquashCommand = input === "/thread squash" ||
      (input.startsWith("/thread squash") && /\s/.test(input["/thread squash".length] ?? ""));
    if (isThreadSquashCommand) {
      if (!this.loop) throw new Error("/thread squash requires a configured model");
      const args = parseCommandLine(input.slice("/thread squash".length).trim());
      if (args.length > 1) throw new Error("Usage: /thread squash [turn-id-or-user-entry-id]");
      if (args.length === 0) {
        const items = buildSquashItems(commandContext);
        return {
          kind: "command",
          result: items.length === 0
            ? ephemeral("(no current-path user turns can be squashed)")
            : viewResult("Choose the first user turn to replace with a squash summary.", {
                type: "thread_squash",
                items,
              }),
        };
      }
      return {
        kind: "turn",
        result: await this.loop.squashFrom(args[0]!, {
          signal: options.signal,
          ...(options.onTextDelta ? { onTextDelta: options.onTextDelta } : {}),
          ...(options.onUiEvent ? { onUiEvent: options.onUiEvent } : {}),
        }),
      };
    }
    const prefixLength = THREAD_COMMAND_PREFIX.length;
    const isThreadCommand = input === THREAD_COMMAND_PREFIX ||
      (input.startsWith(THREAD_COMMAND_PREFIX) && /\s/.test(input[prefixLength] ?? ""));
    if (isThreadCommand) {
      const name = parseCommandLine(input.slice(prefixLength).trim())[0] ?? "help";
      const beforeBranch = this.versions.currentBranch.name;
      const beforeHead = this.versions.head.id;
      safeUiEvent(options.onUiEvent, { type: "command_started", name });
      try {
        const command = await this.commandRouter.route(input, commandContext);
        if (!command) throw new Error(`Could not route command: ${input}`);
        safeUiEvent(options.onUiEvent, { type: "command_finished", name, ok: true });
        if (beforeBranch !== this.versions.currentBranch.name || beforeHead !== this.versions.head.id) {
          safeUiEvent(options.onUiEvent, {
            type: "head_changed",
            branch: this.versions.currentBranch.name,
            checkpointId: this.versions.head.id,
            reason: "command",
          });
        }
        return { kind: "command", result: command };
      } catch (error) {
        safeUiEvent(options.onUiEvent, { type: "command_finished", name, ok: false });
        throw error;
      }
    }
    if (input.startsWith("/rewind") && (input.length === 7 || /\s/.test(input[7]!))) {
      const args = parseCommandLine(input.slice(7).trim());
      if (args.length > 1) throw new Error("Usage: /rewind [turn-id-or-user-entry-id]");
      if (args.length === 0) {
        // No id given: open the rewind picker over the session, one row per
        // user message, and let the user choose how far back to go.
        safeUiEvent(options.onUiEvent, { type: "command_started", name: "rewind" });
        const items = buildHistoryItems(commandContext);
        safeUiEvent(options.onUiEvent, { type: "command_finished", name: "rewind", ok: true });
        if (items.length === 0) {
          return {
            kind: "command",
            result: ephemeral(`(no turns on thread branch ${this.versions.currentBranch.name})`),
          };
        }
        return {
          kind: "command",
          result: viewResult("Choose a user message to rewind to.", { type: "rewind", items }),
        };
      }
      safeUiEvent(options.onUiEvent, { type: "command_started", name: "rewind" });
      try {
        const result = await rewindCommand(args[0]!, commandContext);
        safeUiEvent(options.onUiEvent, { type: "command_finished", name: "rewind", ok: true });
        safeUiEvent(options.onUiEvent, {
          type: "head_changed",
          branch: this.versions.currentBranch.name,
          checkpointId: this.versions.head.id,
          reason: "restore",
        });
        return { kind: "command", result };
      } catch (error) {
        safeUiEvent(options.onUiEvent, { type: "command_finished", name: "rewind", ok: false });
        throw error;
      }
    }
    if (!this.loop) {
      throw new Error(
        "No model configured. Use /model list and /model <provider>/<model>, configure a default, or set --provider/--model.",
      );
    }
    return {
      kind: "turn",
      result: await this.loop.run(input, {
        signal: options.signal,
        ...(options.onTextDelta ? { onTextDelta: options.onTextDelta } : {}),
        ...(options.onUiEvent ? { onUiEvent: options.onUiEvent } : {}),
      }),
    };
  }

  async fsck(): Promise<string[]> {
    return this.fsckRuntime(this.runtime);
  }

  private async fsckRuntime(runtime: SessionRuntime): Promise<string[]> {
    const issues: string[] = [];
    for (const branch of runtime.session.projection.branches.values()) {
      if (!runtime.session.projection.checkpoints.has(branch.headCheckpointId)) {
        issues.push(`branch ${branch.name} references missing checkpoint ${branch.headCheckpointId}`);
      }
    }
    for (const commit of runtime.session.projection.commits.values()) {
      if (!runtime.session.projection.checkpoints.has(commit.checkpointId)) {
        issues.push(`commit ${commit.id} references missing checkpoint ${commit.checkpointId}`);
      }
    }
    for (const checkpoint of runtime.session.projection.checkpoints.values()) {
      try {
        await runtime.versions.workspace.verifySnapshot(checkpoint.workspaceTreeOid, checkpoint.retentionCommitOid);
      } catch (error) {
        issues.push(`checkpoint ${checkpoint.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const keep = await runtime.versions.workspace.readKeepRef();
    if (keep !== runtime.versions.expectedKeepRef) {
      issues.push(`sidecar keep ref is ${keep ?? "missing"}; expected ${runtime.versions.expectedKeepRef ?? "none"}`);
    }
    try {
      for (const branch of runtime.session.projection.branches.keys()) {
        runtime.session.projection.assertIdleInvariant(branch);
      }
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
    return issues;
  }

  async close(): Promise<void> {
    await this.runtime.log.close();
  }
}
