import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import path from "node:path";
import { AgentRuntime, type TurnResult } from "../agent/runtime.js";
import type { ModelCatalog, ModelClient } from "../agent/model-client.js";
import { AgentProfileRegistry, MAIN_AGENT_PROFILE_ID, type AgentProfile, type AgentProfileDiagnostic } from "../agent/profile.js";
import { AgentTaskOrchestrator } from "../agent-task/orchestrator.js";
import { AgentTaskRepository } from "../agent-task/repository.js";
import { createImplementationWorkerProfile, DEFAULT_IMPLEMENTATION_WORKER_SETTINGS, IMPLEMENTATION_WORKER_PROFILE_ID, type ImplementationWorkerProfileSettings } from "../agent-task/profile.js";
import { AGENT_TASK_ORCHESTRATION_PROMPT } from "../agent-task/prompt.js";
import { createAgentTaskTools } from "../agent-task/tools.js";
import { createAgentRuntime } from "./create-agent-runtime.js";
import { bindModel, ModelSelection } from "./model-selection.js";
import { getThreadHome } from "../config/home.js";
import type { ThreadState } from "./state.js";
import { ContextBuilder } from "../context/builder.js";
import { contextBudget } from "../context/budget.js";
import { createDreamerProfile, DEFAULT_DREAMER_THINKING_LEVEL, DREAMER_PROFILE_ID } from "../dreamer/profile.js";
import { DreamerScheduler } from "../dreamer/scheduler.js";
import { ExtensionEvents, type ExtensionEventType, type ExtensionHandler } from "../extensions/events.js";
import { FileHistoryService } from "../file-history/service.js";
import { formatGlobalMemoryPrompt, GlobalMemorySnapshots } from "../global-memory.js";
import type { Project } from "../project/model.js";
import { ProjectService } from "../project/service.js";
import { SessionRecallService } from "../session-recall/service.js";
import { SessionTreeRepository } from "../session-tree/repository.js";
import { SessionTreeService } from "../session-tree/service.js";
import { messageWithoutImages } from "../session-tree/user-content.js";
import { formatSkillsSection, loadSkills, type LoadedSkills } from "../skills/loader.js";
import { createAskTool } from "../tools/ask.js";
import { snapshotRuntimeOptions, snapshotTool, type ThreadRuntimeOptions, type RuntimeOptionsSnapshot, type PromptOptions, type RewindOptions } from "./options.js";
import { createSessionReadTool, createSessionSearchTool } from "../tools/session-recall.js";
import { createSkillTool, formatSkillInvocation } from "../tools/skill.js";
import { ToolRegistry, type AgentTool } from "../tools/types.js";
import type { AskPresenter } from "./interaction.js";
import { safeRuntimeEvent, type RuntimeEvent, type RuntimeEventSink } from "./events.js";

interface RuntimeResources {
  project: Project;
  repository: SessionTreeRepository;
  tree: SessionTreeService;
  fileHistory: FileHistoryService;
  skills: LoadedSkills;
  recall: SessionRecallService | undefined;
  taskRepository: AgentTaskRepository;
  memory: GlobalMemorySnapshots | undefined;
}

interface ActiveOperation {
  sessionId?: string;
  controller: AbortController;
  signal: AbortSignal;
  done: Promise<unknown>;
}

/** A project-owned runtime. One foreground operation runs at a time, with an explicit target session. */
export class ThreadRuntime {
  readonly project: Project;
  readonly rootPath: string;
  readonly initialSessionId: string;
  private readonly tree: SessionTreeService;
  private readonly files: FileHistoryService;
  private readonly recallService: SessionRecallService | undefined;
  private readonly profiles: AgentProfileRegistry;
  private readonly tasks: AgentTaskOrchestrator;
  private readonly toolRegistry = new ToolRegistry();
  private readonly extensions = new ExtensionEvents();
  private readonly modelCatalog: ModelCatalog | undefined;
  private readonly repository: SessionTreeRepository;
  private readonly builder: ContextBuilder;
  private readonly modelSelection: ModelSelection;
  private readonly memory: GlobalMemorySnapshots | undefined;
  private readonly dreamer: DreamerScheduler | undefined;
  private readonly options: RuntimeOptionsSnapshot;
  private readonly loadedSkills: LoadedSkills;
  private readonly workerSettings: ImplementationWorkerProfileSettings;
  private readonly listeners = new Set<RuntimeEventSink>();
  private state: ThreadState;
  private askPresenter: AskPresenter | undefined;
  private askDisposer: (() => void) | undefined;
  private taskToolDisposers: (() => void)[] = [];
  private active: ActiveOperation | undefined;
  private closing: Promise<void> | undefined;

  private constructor(options: RuntimeOptionsSnapshot, values: RuntimeResources) {
    this.options = options;
    this.project = Object.freeze({ ...values.project });
    this.rootPath = values.project.rootPath;
    this.tree = values.tree;
    this.initialSessionId = values.tree.activeSession.id;
    this.files = values.fileHistory;
    this.repository = values.repository;
    this.builder = new ContextBuilder(this.tree);
    this.recallService = values.recall;
    this.memory = values.memory;
    this.modelCatalog = options.modelCatalog;
    this.loadedSkills = values.skills;
    this.state = structuredClone(options.state ?? {});
    this.workerSettings = options.implementationWorker?.settings ?? DEFAULT_IMPLEMENTATION_WORKER_SETTINGS;
    this.modelSelection = new ModelSelection(this.tree.tree.id, options.cacheRetention,
      options.thinkingLevel ?? "medium", (state) => this.remember({ ...this.state, ...state }));
    const worker = options.implementationWorker?.enabled && options.implementationWorker.model
      ? this.bindProfile(createImplementationWorkerProfile(options.implementationWorker.model, this.workerSettings, this.fileCheckpoints)) : undefined;
    const dreamer = options.dreamer?.enabled && options.dreamer.model
      ? this.bindProfile(createDreamerProfile(options.dreamer.model, options.dreamer.thinkingLevel ?? DEFAULT_DREAMER_THINKING_LEVEL)) : undefined;
    if (dreamer && !this.memory) throw new Error("Dreamer requires globalMemoryPath");
    this.profiles = new AgentProfileRegistry([worker, dreamer].filter((profile): profile is AgentProfile => !!profile), options.agentProfileDiagnostics);
    this.tasks = new AgentTaskOrchestrator(values.taskRepository, this.profiles, this.rootPath, this.workerSettings, this.files, {
      ...(options.toolPolicy ? { toolPolicy: options.toolPolicy } : {}),
      sessionIdForTurn: (turnId) => this.tree.projection.turns.get(turnId)?.sessionId,
    });
    this.dreamer = this.memory ? new DreamerScheduler(this.rootPath, this.memory.filePath, dreamer, {
      ...(options.toolPolicy ? { toolPolicy: options.toolPolicy } : {}),
    }) : undefined;
    for (const tool of options.tools) this.toolRegistry.register(tool);
    if (this.recallService) {
      this.toolRegistry.register(createSessionSearchTool(this.recallService));
      this.toolRegistry.register(createSessionReadTool(this.recallService));
      this.extensions.on("turn_end", () => this.recallService?.turnFinished());
    }
    if (this.loadedSkills.skills.some((skill) => !skill.disableModelInvocation)) {
      this.toolRegistry.register(createSkillTool(() => this.loadedSkills.skills));
    }
    this.syncTaskTools();
    this.setAskPresenter(options.askPresenter);
    this.modelSelection.select(options.model);
  }

  static async open(input: ThreadRuntimeOptions): Promise<ThreadRuntime> {
    const options = snapshotRuntimeOptions(input);
    const project = await ProjectService.open(options.rootPath, options.stateDirectory ? { stateDirectory: options.stateDirectory } : {});
    const skills = options.skills && "paths" in options.skills
      ? await loadSkills(options.skills.paths.map((directory) => path.resolve(project.rootPath, directory)))
      : options.skills ?? { skills: [], diagnostics: [] };
    let repository: SessionTreeRepository | undefined;
    let taskRepository: AgentTaskRepository | undefined;
    let recall: SessionRecallService | undefined;
    try {
      repository = await SessionTreeRepository.open(project);
      const tree = new SessionTreeService(repository);
      await tree.initialize();
      const memory = options.globalMemoryPath
        ? await GlobalMemorySnapshots.open([...tree.projection.sessions.keys()], path.resolve(options.globalMemoryPath)) : undefined;
      const fileHistory = new FileHistoryService(project, tree,
        [options.stateDirectory ?? getThreadHome(), ...(memory ? [memory.filePath] : [])], options.fileCheckpoints ?? false);
      recall = options.search ? new SessionRecallService(tree, options.search) : undefined;
      taskRepository = await AgentTaskRepository.open(project);
      const runtime = new ThreadRuntime(options, { project, repository, tree, fileHistory, skills, recall, taskRepository, memory });
      await runtime.tasks.initialize();
      return runtime;
    } catch (error) {
      await Promise.allSettled([recall?.close(), taskRepository?.close(), repository?.close()]);
      throw error;
    }
  }

  get model() { return this.modelSelection.model; }
  get thinkingLevel() { return this.modelSelection.thinkingLevel; }
  get supportsThinking() { return this.modelSelection.supportsThinking; }
  get availableThinkingLevels() { return this.modelSelection.availableThinkingLevels; }
  get skills() { return structuredClone(this.loadedSkills.skills); }
  get skillDiagnostics() { return structuredClone(this.loadedSkills.diagnostics); }
  get fileCheckpoints() { return this.files.captureEnabled; }
  get recallEnabled() { return !!this.recallService; }
  get treeId() { return this.tree.tree.id; }
  get subagentEnabled() { return this.tasks.enabled; }
  get dreamerEnabled() { return this.dreamer?.enabled ?? false; }
  get dreamerLastError() { return this.dreamer?.lastError; }
  get subagentModel() { return this.secondaryModel(IMPLEMENTATION_WORKER_PROFILE_ID); }
  get dreamerModel() { return this.secondaryModel(DREAMER_PROFILE_ID); }
  get agentProfileDiagnostics(): readonly AgentProfileDiagnostic[] {
    return [...this.profiles.diagnostics, ...(this.memory?.diagnostic
      ? [{ profileId: "main", level: "warning" as const, message: this.memory.diagnostic }] : [])];
  }

  listSessions() {
    this.assertOpen();
    return [...this.tree.projection.sessions.values()].map((session) => ({
      sessionId: session.id,
      liveTipTurnId: this.tree.projection.liveTips.get(session.id) ?? null,
      turnCount: [...this.tree.projection.turns.values()].filter((turn) => turn.sessionId === session.id).length,
      createdAt: session.createdAt,
    })).sort((a, b) => b.createdAt - a.createdAt);
  }

  readSession(sessionId: string) {
    this.assertOpen();
    const session = this.tree.resolveSession(sessionId);
    const turns = this.tree.livePath(session.id);
    return structuredClone({ session, liveTipTurnId: this.tree.projection.liveTips.get(session.id) ?? null,
      turns, entries: turns.flatMap((turn) => this.tree.entriesForTurn(turn.id)),
      tasks: turns.flatMap((turn) => this.agentTaskDetailsForTurn(turn.id)) });
  }

  /** Complete retained project history, including paths abandoned by rewind. */
  readHistory() {
    this.assertOpen();
    return structuredClone({ tree: this.tree.tree, sessions: [...this.tree.projection.sessions.values()],
      turns: [...this.tree.projection.turns.values()], entries: [...this.tree.projection.entries.values()],
      liveTips: Object.fromEntries(this.tree.projection.liveTips) });
  }

  createSession(options: { signal?: AbortSignal } = {}) {
    return this.operate(undefined, options.signal, async (signal) => {
      const snapshot = await this.memory?.loadFresh();
      signal.throwIfAborted();
      const session = await this.tree.createSession();
      if (snapshot !== undefined) this.memory?.bind(session.id, snapshot);
      this.publish({ type: "session_changed", sessionId: session.id, turnId: null, liveTipTurnId: null, reason: "new" });
      return session;
    });
  }

  /** Records the session to reopen next time, without redirecting explicit prompt targets. */
  openSession(sessionId: string, options: { signal?: AbortSignal } = {}) {
    return this.operate(sessionId, options.signal, async (signal) => {
      signal.throwIfAborted();
      const session = await this.tree.openSession(sessionId);
      const liveTipTurnId = this.tree.projection.liveTips.get(session.id) ?? null;
      this.publish({ type: "session_changed", sessionId: session.id, turnId: liveTipTurnId, liveTipTurnId, reason: "opened" });
      return session;
    });
  }

  searchHistory(queries: readonly string[], options: { limit?: number; signal?: AbortSignal } = {}) {
    return this.operate(undefined, options.signal, (signal) => {
      if (!this.recallService) throw new Error("Session recall is disabled");
      return this.recallService.search(queries, options.limit ?? 8, signal);
    });
  }

  prompt(sessionId: string, input: string, options: PromptOptions = {}): Promise<TurnResult> {
    return this.operate(sessionId, options.signal, async (signal) => {
      const session = this.tree.resolveSession(sessionId);
      if (!this.model) throw new Error("No model configured");
      if (options.images?.length && this.model.acceptsImages !== true) throw new Error("Current model does not accept images");
      const runner = this.createAgentRuntime(session.id);
      const result = await runner.run(input, { ...options, sessionId: session.id, signal,
        onEvent: (event) => { this.publish(event); safeRuntimeEvent(options.onEvent, event); } });
      this.dreamer?.recordTurn(this.tree.messagesForTurn(result.turn.id));
      return result;
    });
  }

  invokeSkill(sessionId: string, name: string, extra?: string, options: PromptOptions = {}) {
    const skill = this.skills.find((item) => item.name === name);
    if (!skill) return Promise.reject(new Error(`Unknown skill: ${name}`));
    return this.prompt(sessionId, formatSkillInvocation(skill, extra), options);
  }

  compact(sessionId: string, options: PromptOptions = {}) {
    return this.operate(sessionId, options.signal, (signal) => {
      const session = this.tree.resolveSession(sessionId);
      if (!this.model) throw new Error("Compaction requires a configured model");
      return this.createAgentRuntime(session.id).compactCurrent({ ...options, sessionId: session.id, signal,
        onEvent: (event) => { this.publish(event); safeRuntimeEvent(options.onEvent, event); } });
    });
  }

  rewind(sessionId: string, turnIdOrUserEntryId: string, options: RewindOptions = {}) {
    return this.operate(sessionId, options.signal, async (signal) => {
      const session = this.tree.resolveSession(sessionId);
      const candidate = this.tree.resolveRewindCandidate(turnIdOrUserEntryId, session.id);
      const livePath = this.tree.livePath(session.id);
      signal.throwIfAborted();
      // Once restoration begins, complete it and the corresponding live-tip write together.
      if (options.restoreFiles ?? this.fileCheckpoints) {
        await this.files.restore(livePath.slice(livePath.findIndex((turn) => turn.id === candidate.turnId)));
      }
      const turn = this.tree.projection.turns.get(candidate.turnId)!;
      await this.tree.moveLiveTipForRewind(turn.parentTurnId, session.id);
      this.publish({ type: "session_changed", sessionId: session.id, turnId: turn.parentTurnId,
        liveTipTurnId: turn.parentTurnId, reason: "rewind" });
      return candidate;
    });
  }

  rewindCandidates(sessionId: string) {
    this.assertOpen();
    return this.tree.rewindCandidates(this.tree.resolveSession(sessionId).id);
  }

  contextMessages(sessionId: string): Message[] {
    this.assertOpen();
    return this.builder.build(undefined, this.tree.resolveSession(sessionId).id).messages;
  }

  contextUsage(sessionId: string) {
    this.assertOpen();
    if (!this.model) return undefined;
    const session = this.tree.resolveSession(sessionId);
    const messages = this.contextMessages(session.id);
    const { requestTokens } = contextBudget({
      systemPrompt: this.systemPromptFor(session.id),
      messages: this.model.acceptsImages ? messages : messages.map(messageWithoutImages),
      tools: this.toolRegistry.modelDefinitions(),
    }, messages);
    return { requestTokens, contextWindow: this.model.contextWindow };
  }

  subscribe(listener: RuntimeEventSink): () => void {
    this.assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async interrupt(sessionId: string): Promise<void> {
    this.assertOpen();
    const id = this.tree.resolveSession(sessionId).id;
    const active = this.active;
    if (!active || active.sessionId !== id) return;
    active.controller.abort(new DOMException("Interrupted by host", "AbortError"));
    await this.settleCancellation(active);
  }

  registerTool(tool: AgentTool): () => void {
    this.assertIdle();
    const dispose = this.toolRegistry.register(snapshotTool(tool));
    return () => { this.assertIdle(); dispose(); };
  }

  on<K extends ExtensionEventType>(type: K, handler: ExtensionHandler<K>): () => void {
    this.assertOpen();
    return this.extensions.on(type, handler);
  }

  setAskPresenter(presenter: AskPresenter | undefined): () => void {
    this.assertOpen();
    this.askPresenter = presenter;
    if (presenter && !this.toolRegistry.get("ask")) this.askDisposer = this.toolRegistry.register(createAskTool());
    if (!presenter) { this.askDisposer?.(); this.askDisposer = undefined; }
    return () => {
      if (this.askPresenter !== presenter) return;
      this.askPresenter = undefined;
      this.askDisposer?.();
      this.askDisposer = undefined;
    };
  }

  setModel(model: ModelClient): void {
    this.assertIdle();
    this.modelSelection.select(model);
    this.modelSelection.remember();
  }

  selectModel(providerId: string, modelId: string): void {
    if (!this.modelCatalog) throw new Error("Model switching is unavailable");
    this.setModel(this.modelCatalog.createClient(providerId, modelId));
  }

  /** Changes preferences for the next turn; an active runner retains its captured settings. */
  setThinkingLevel(level: ModelThinkingLevel): void {
    this.assertOpen();
    this.modelSelection.setThinkingLevel(level);
  }

  cycleThinkingLevel(): ModelThinkingLevel | undefined {
    this.assertOpen();
    return this.modelSelection.cycleThinkingLevel();
  }

  configureAgent(id: typeof IMPLEMENTATION_WORKER_PROFILE_ID | typeof DREAMER_PROFILE_ID, enabled: boolean, model?: ModelClient): void {
    this.assertIdle();
    const previous = this.secondaryModel(id);
    if (enabled) {
      if (!model) throw new Error("An enabled agent requires a model");
      if (id === DREAMER_PROFILE_ID && !this.dreamer) throw new Error("Dreamer requires globalMemoryPath");
      const profile = this.bindProfile(id === IMPLEMENTATION_WORKER_PROFILE_ID
        ? createImplementationWorkerProfile(model, this.workerSettings, this.fileCheckpoints)
        : createDreamerProfile(model, this.options.dreamer?.thinkingLevel ?? DEFAULT_DREAMER_THINKING_LEVEL));
      const old = this.profiles.get(id);
      this.profiles.set(profile);
      try { this.syncTaskTools(); } catch (error) {
        if (old) this.profiles.set(old); else this.profiles.delete(id);
        throw error;
      }
      if (id === DREAMER_PROFILE_ID) this.dreamer!.setProfile(profile);
    } else {
      this.profiles.delete(id);
      this.syncTaskTools();
      if (id === DREAMER_PROFILE_ID) this.dreamer?.setProfile(undefined);
    }
    this.profiles.clearDiagnostics(id);
    const selection = model ? { provider: model.providerId, id: model.modelId } : previous;
    this.remember({ ...this.state, agents: { ...this.state.agents, [id]: { enabled, ...(selection ? { model: selection } : {}) } } });
  }

  agentTaskSummaries(parentTurnId: string) { return structuredClone(this.tasks.summariesForTurn(parentTurnId)); }
  agentTaskDetailsForTurn(parentTurnId: string) {
    return [...this.tasks.repository.projection.tasks.values()].filter((task) => task.parentTurnId === parentTurnId)
      .map((task) => ({ task: structuredClone(task), summary: this.tasks.repository.projection.summary(task.id) }));
  }

  async fsck(): Promise<string[]> {
    this.assertOpen();
    const issues: string[] = [];
    for (const session of this.tree.projection.sessions.values()) {
      try {
        this.tree.livePath(session.id);
      } catch (error) {
        issues.push(`session ${session.id} live path: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const turn of this.tree.projection.turns.values()) {
      const entries = this.tree.projection.entriesByTurn.get(turn.id) ?? [];
      if (entries[0]?.id !== turn.userEntryId || entries[0]?.type !== "message" || entries[0].message.role !== "user") {
        issues.push(`turn ${turn.id} has no leading user entry`);
      }
      try {
        await this.files.verify(turn.id);
      } catch (error) {
        issues.push(`turn ${turn.id} file history: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return issues;
  }

  cleanupFileHistory() {
    return this.operate(undefined, undefined, () => this.files.garbageCollect());
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("Thread runtime is closed or closing");
  }

  private assertIdle(): void {
    this.assertOpen();
    if (this.active) throw new Error("Wait for the active turn or command to finish");
    this.tree.requireIdle();
  }

  private operate<T>(sessionId: string | undefined, signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
    let resolvedSessionId: string | undefined;
    try {
      this.assertIdle();
      signal?.throwIfAborted();
      resolvedSessionId = sessionId ? this.tree.resolveSession(sessionId).id : undefined;
    } catch (error) { return Promise.reject(error); }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const active: ActiveOperation = { ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}), controller, signal: combined, done: Promise.resolve() };
    this.active = active;
    this.dreamer?.foregroundStarting();
    const done = Promise.resolve().then(() => { combined.throwIfAborted(); return operation(combined); }).finally(() => {
      if (this.active === active) this.active = undefined;
      if (!this.closing) this.dreamer?.foregroundFinished();
    });
    active.done = done;
    void done.catch(() => undefined);
    return done;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const active = this.active;
    // Publish the closing state before an abort handler can re-enter this instance.
    this.closing = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      const collect = (task: Promise<unknown> | undefined) => task?.catch((error) => { failures.push(error); });
      await collect(active ? this.settleCancellation(active) : undefined);
      await Promise.all([collect(this.tasks.close()), collect(this.dreamer?.close()), collect(this.recallService?.close())]);
      await collect(this.files.settle());
      await collect(this.repository.close());
      this.listeners.clear();
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Thread resources failed to close cleanly");
    });
    active?.controller.abort(new DOMException("Thread runtime closed", "AbortError"));
    return this.closing;
  }

  private settleCancellation(active: ActiveOperation): Promise<unknown> {
    return active.done.catch((error) => {
      if (active.signal.aborted && error === active.signal.reason) return;
      throw error;
    });
  }

  private publish(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      safeRuntimeEvent(listener, event);
    }
  }

  private remember(state: ThreadState): void {
    this.state = state;
    this.options.onStateChange?.(structuredClone(state));
  }

  private secondaryModel(id: typeof IMPLEMENTATION_WORKER_PROFILE_ID | typeof DREAMER_PROFILE_ID) {
    const profile = this.profiles.get(id);
    if (profile) return { provider: profile.model.providerId, id: profile.model.modelId };
    return this.state.agents?.[id]?.model ?? (id === IMPLEMENTATION_WORKER_PROFILE_ID
      ? this.options.implementationWorker?.defaultModel : this.options.dreamer?.defaultModel);
  }

  private syncTaskTools(): void {
    if (!this.tasks.enabled) { for (const dispose of this.taskToolDisposers.splice(0)) dispose(); return; }
    if (this.taskToolDisposers.length) return;
    const tools = createAgentTaskTools(this.tasks);
    const conflict = tools.find((tool) => this.toolRegistry.get(tool.name));
    if (conflict) throw new Error(`Cannot enable subagents because tool ${conflict.name} is already registered`);
    this.taskToolDisposers = tools.map((tool) => this.toolRegistry.register(tool));
  }

  private bindProfile(profile: AgentProfile): AgentProfile {
    const model = bindModel(profile.model, `${this.tree.tree.id}:${profile.id}`, this.options.cacheRetention);
    return { ...profile, model, systemPrompt: [profile.systemPrompt,
      profile.id === IMPLEMENTATION_WORKER_PROFILE_ID ? this.options.sharedInstructions : undefined].filter(Boolean).join("\n\n") };
  }

  private createAgentRuntime(sessionId: string): AgentRuntime {
    if (!this.model) throw new Error("No model configured");
    const systemPrompt = this.systemPromptFor(sessionId);
    return createAgentRuntime({ model: this.model, ...(this.modelSelection.reasoning ? { reasoning: this.modelSelection.reasoning } : {}),
      rootPath: this.rootPath, systemPrompt, tree: this.tree, fileHistory: this.files, contextBuilder: this.builder,
      tools: this.toolRegistry, extensions: this.extensions, agentTasks: this.tasks, askPresenter: () => this.askPresenter,
      writableExternalPaths: [...(this.options.writableExternalPaths ?? []), ...(this.memory ? [this.memory.filePath] : [])],
      ...(this.options.toolPolicy ? { toolPolicy: this.options.toolPolicy } : {}), profileId: MAIN_AGENT_PROFILE_ID });
  }

  private systemPromptFor(sessionId: string): string {
    return [this.options.systemPrompt ?? "", this.options.appendSystemPrompt, this.options.sharedInstructions,
      this.tasks.enabled ? AGENT_TASK_ORCHESTRATION_PROMPT : "", formatSkillsSection(this.loadedSkills.skills),
      this.memory ? formatGlobalMemoryPrompt(this.memory.filePath, this.memory.snapshot(sessionId)) : ""].filter(Boolean).join("\n\n");
  }

}
