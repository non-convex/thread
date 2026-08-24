import { rm } from "node:fs/promises";
import path from "node:path";
import type { ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import { clearDisplayResult, ephemeral, viewResult, type CommandResult } from "./commands/types.js";
import { buildHistoryItems, registerBuiltinCommands, rewindCommand } from "./commands/builtins.js";
import { parseCommandLine } from "./commands/parser.js";
import { THREAD_COMMAND_PREFIX, ThreadCommandRouter } from "./commands/registry.js";
import { CommandRegistry } from "./commands/types.js";
import { AgentLoop, type TurnResult } from "./agent/loop.js";
import type { ModelCatalog, ModelClient, ModelDescriptor } from "./agent/model-client.js";
import { ModelSemanticRunner } from "./agent/semantic-runner.js";
import { createExtensionAPI, type ExtensionAPI } from "./extensions/api.js";
import { ExtensionEvents } from "./extensions/events.js";
import { DerivedCache } from "./persistence/cache.js";
import { CapsuleService } from "./revisions/capsule-service.js";
import { DiffService } from "./revisions/diff-service.js";
import { MergeService } from "./revisions/merge-service.js";
import { VersionService } from "./revisions/version-service.js";
import { SessionLogStore } from "./session/log-store.js";
import { SessionService } from "./session/service.js";
import { registerBuiltinTools } from "./tools/builtins.js";
import { ToolRegistry } from "./tools/types.js";
import { safeUiEvent, type UiEventSink } from "./ui/events.js";
import { discoverGitWorkspace, type GitWorkspace } from "./workspace/discovery.js";
import { SidecarWorkspaceStore } from "./workspace/sidecar-store.js";

export interface ThreadAppOptions {
  rootPath: string;
  model?: ModelClient;
  modelCatalog?: ModelCatalog;
  thinkingLevel?: ModelThinkingLevel;
  systemPrompt?: string;
}

export type InputResult =
  | { kind: "command"; result: CommandResult }
  | { kind: "turn"; result: TurnResult };

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_THINKING_LEVEL: ModelThinkingLevel = "medium";

export class ThreadApp {
  readonly extensionApi: ExtensionAPI;
  readonly rootPath: string;
  readonly session: SessionService;
  readonly versions: VersionService;
  readonly tools: ToolRegistry;
  readonly commands: CommandRegistry;
  capsules!: CapsuleService;
  diff!: DiffService;
  merge!: MergeService;
  readonly workspace: GitWorkspace;
  private readonly log: SessionLogStore;
  private readonly cache: DerivedCache;
  private readonly events: ExtensionEvents;
  private readonly modelCatalog: ModelCatalog | undefined;
  private readonly systemPrompt: string | undefined;
  private readonly commandRouter: ThreadCommandRouter;
  private currentModel: ModelClient | undefined;
  private preferredThinkingLevel: ModelThinkingLevel;
  private currentThinkingLevel: ModelThinkingLevel = "off";
  private loop: AgentLoop | undefined;

  private constructor(
    options: ThreadAppOptions,
    workspace: GitWorkspace,
    log: SessionLogStore,
    session: SessionService,
    versions: VersionService,
  ) {
    this.rootPath = workspace.rootPath;
    this.workspace = workspace;
    this.log = log;
    this.session = session;
    this.versions = versions;
    this.cache = new DerivedCache(log.cacheDir);
    this.events = new ExtensionEvents();
    this.modelCatalog = options.modelCatalog;
    this.systemPrompt = options.systemPrompt;
    this.tools = new ToolRegistry();
    registerBuiltinTools(this.tools);
    this.commands = new CommandRegistry();
    registerBuiltinCommands(this.commands);
    this.commandRouter = new ThreadCommandRouter(this.commands);
    this.extensionApi = createExtensionAPI(this.tools, this.commands, this.events);
    this.preferredThinkingLevel = options.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
    this.configureRuntime(options.model);
  }

  static async open(options: ThreadAppOptions): Promise<ThreadApp> {
    const workspace = await discoverGitWorkspace(path.resolve(options.rootPath));
    const log = await SessionLogStore.open({ rootPath: workspace.rootPath, sidecarRoot: workspace.sidecarRoot });
    try {
      const session = new SessionService(log);
      const sidecar = new SidecarWorkspaceStore({ workspace, sessionId: log.sessionId });
      const versions = new VersionService(session, sidecar);
      await versions.initialize(workspace.rootPath);
      return new ThreadApp(options, workspace, log, session, versions);
    } catch (error) {
      await log.close();
      throw error;
    }
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

  cycleThinkingLevel(): ModelThinkingLevel | undefined {
    if (!this.currentModel?.reasoning) return undefined;
    const levels = this.thinkingLevelsFor(this.currentModel);
    const currentIndex = levels.indexOf(this.currentThinkingLevel);
    this.preferredThinkingLevel = levels[(currentIndex + 1) % levels.length]!;
    this.configureRuntime(this.currentModel);
    return this.currentThinkingLevel;
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

  private configureRuntime(model: ModelClient | undefined): void {
    this.currentModel = model;
    this.currentThinkingLevel = this.clampThinkingLevel(model, this.preferredThinkingLevel);
    const reasoning = this.requestReasoning();
    const semantic = model ? new ModelSemanticRunner(model, reasoning) : undefined;
    this.capsules = new CapsuleService(this.session, this.cache, semantic);
    this.diff = new DiffService(this.versions, this.session, this.capsules, this.cache, semantic);
    this.merge = new MergeService(this.versions, this.session, this.capsules, semantic);
    this.loop = model
      ? new AgentLoop(
          this.rootPath,
          model,
          this.session,
          this.versions,
          this.tools,
          this.events,
          {
            ...(this.systemPrompt ? { systemPrompt: this.systemPrompt } : {}),
            ...(reasoning ? { reasoning } : {}),
          },
        )
      : undefined;
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
    return ephemeral(`Switched model from ${previous} to ${providerId}/${modelId}`, true);
  }

  async handleInput(
    input: string,
    options: { signal: AbortSignal; onTextDelta?: (delta: string) => void; onUiEvent?: UiEventSink },
  ): Promise<InputResult> {
    const commandContext = {
      rootPath: this.rootPath,
      versions: this.versions,
      diff: this.diff,
      merge: this.merge,
      capsules: this.capsules,
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
    const issues: string[] = [];
    for (const branch of this.session.projection.branches.values()) {
      if (!this.session.projection.checkpoints.has(branch.headCheckpointId)) {
        issues.push(`branch ${branch.name} references missing checkpoint ${branch.headCheckpointId}`);
      }
    }
    for (const commit of this.session.projection.commits.values()) {
      if (!this.session.projection.checkpoints.has(commit.checkpointId)) {
        issues.push(`commit ${commit.id} references missing checkpoint ${commit.checkpointId}`);
      }
    }
    for (const checkpoint of this.session.projection.checkpoints.values()) {
      try {
        await this.versions.workspace.verifySnapshot(checkpoint.workspaceTreeOid, checkpoint.retentionCommitOid);
      } catch (error) {
        issues.push(`checkpoint ${checkpoint.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const keep = await this.versions.workspace.readKeepRef();
    if (keep !== this.versions.expectedKeepRef) {
      issues.push(`sidecar keep ref is ${keep ?? "missing"}; expected ${this.versions.expectedKeepRef ?? "none"}`);
    }
    try {
      for (const branch of this.session.projection.branches.keys()) this.session.projection.assertIdleInvariant(branch);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
    return issues;
  }

  close(): Promise<void> {
    return this.log.close();
  }

  async deleteProjectSession(): Promise<void> {
    await this.log.close();
    await rm(this.log.sessionDir, { recursive: true, force: true });
    await this.versions.workspace.deleteSessionObjects();
  }
}
