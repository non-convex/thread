import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentRunner, type TurnResult } from "../agent/runner.js";
import type { RunTurnOptions } from "../agent/turn-runner.js";
import type { ModelClient } from "../agent/model-client.js";
import { PromptCacheDiagnostics } from "../agent/prompt-cache-diagnostics.js";
import type { ModelCatalog } from "../agent/model-catalog.js";
import { AgentProfileRegistry, MAIN_AGENT_PROFILE_ID, type AgentProfile, type AgentProfileDiagnostic } from "../agent/profile.js";
import { AgentTaskOrchestrator } from "../agent-task/orchestrator.js";
import { createWorkerProfile, DEFAULT_WORKER_SETTINGS, WORKER_PROFILE_ID, type WorkerProfileSettings } from "../agent-task/profile.js";
import { AGENT_TASK_ORCHESTRATION_PROMPT } from "../agent-task/prompt.js";
import { createAgentTaskTools } from "../agent-task/tools.js";
import { createAgentRunner } from "./create-agent-runner.js";
import { bindModel, ModelSelection } from "./model-selection.js";
import type { ThreadState } from "./state.js";
import { ContextBuilder } from "../context/builder.js";
import { contextBudget } from "../context/budget.js";
import { createDreamerProfile, DEFAULT_DREAMER_THINKING_LEVEL, DREAMER_PROFILE_ID } from "../dreamer/profile.js";
import { DreamerScheduler } from "../dreamer/scheduler.js";
import { ExtensionEvents, type ExtensionEventType, type ExtensionHandler } from "../extensions/events.js";
import type { FileHistoryService } from "../file-history/service.js";
import { formatGlobalMemoryPrompt, GlobalMemorySnapshots } from "../global-memory.js";
import type { Project } from "../project/model.js";
import type { SessionRecallService } from "../session-recall/service.js";
import type { SessionTreeRepository } from "../session-tree/repository.js";
import type { SessionGoal } from "../session-tree/model.js";
import { createId } from "../utils/id.js";
import { createGoalTool, goalPrompt, GOAL_TOOL_NAME, DEFAULT_GOAL_MAX_TURNS, type GoalDecision } from "./goal.js";
import type { SessionTreeService } from "../session-tree/service.js";
import { messageWithoutImages } from "../session-tree/user-content.js";
import { formatSkillsSection, type LoadedSkills } from "../skills/loader.js";
import { openRuntimeResources, type RuntimeResources } from "./resources.js";
import { createAskTool } from "../tools/ask.js";
import { snapshotRuntimeOptions, snapshotTool, type ThreadRuntimeOptions, type RuntimeOptionsSnapshot, type PromptOptions, type GoalOptions, type RewindOptions } from "./options.js";
import { createSessionReadTool, createSessionSearchTool } from "../tools/session-recall.js";
import { createSkillTool, formatSkillInvocation } from "../tools/skill.js";
import { ToolRegistry, type AgentTool } from "../tools/types.js";
import type { AskPresenter } from "./interaction.js";
import { runtimeEventSink, withoutModelContent, safeRuntimeEvent, type RuntimeSubscriptionOptions, type RuntimeEvent, type RuntimeEventSink } from "./events.js";

interface ActiveOperation {
  sessionId?: string;
  goalId?: string;
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
  private readonly protectedWritePaths: readonly string[];
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
  private readonly workerSettings: WorkerProfileSettings;
  private readonly listeners = new Map<RuntimeEventSink, RuntimeSubscriptionOptions>();
  private cacheDiagnostics: PromptCacheDiagnostics | undefined;
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
    this.protectedWritePaths = values.protectedWritePaths;
    this.repository = values.repository;
    this.builder = new ContextBuilder(this.tree);
    this.recallService = values.recall;
    this.memory = values.memory;
    this.modelCatalog = options.modelCatalog;
    this.loadedSkills = values.skills;
    this.state = structuredClone(options.state ?? {});
    this.workerSettings = options.worker?.settings ?? DEFAULT_WORKER_SETTINGS;
    this.modelSelection = new ModelSelection(this.tree.tree.id, options.cacheRetention,
      options.thinkingLevel ?? "medium", (state) => this.remember({ ...this.state, ...state }));
    const worker = options.worker?.enabled && options.worker.model
      ? this.bindProfile(createWorkerProfile(options.worker.model, this.workerSettings)) : undefined;
    const dreamer = options.dreamer?.enabled && options.dreamer.model
      ? this.bindProfile(createDreamerProfile(options.dreamer.model, options.dreamer.thinkingLevel ?? DEFAULT_DREAMER_THINKING_LEVEL)) : undefined;
    if (dreamer && !this.memory) throw new Error("Dreamer requires globalMemoryPath");
    this.profiles = new AgentProfileRegistry([worker, dreamer].filter((profile): profile is AgentProfile => !!profile), options.agentProfileDiagnostics);
    this.tasks = new AgentTaskOrchestrator(values.taskRepository, this.profiles, this.rootPath, this.workerSettings, this.files, {
      protectedWritePaths: this.protectedWritePaths,
      ...(options.toolPolicy ? { toolPolicy: options.toolPolicy } : {}),
      sessionIdForTurn: (turnId) => this.tree.projection.turns.get(turnId)?.sessionId,
    });
    this.dreamer = this.memory ? new DreamerScheduler(this.rootPath, this.memory.filePath, dreamer, {
      readTurn: (turnId) => {
        const entries = this.tree.projection.entriesByTurn.get(turnId);
        if (!entries) throw new Error(`Dreamer cannot read missing turn: ${turnId}`);
        return (function* () {
          for (const entry of entries) if (entry.type === "message") yield entry.message;
        })();
      },
      pendingTurns: () => this.tree.pendingDreamerTurns(this.memory!.filePath).map((turn) => ({
        id: turn.id, sessionId: turn.sessionId, status: turn.status, startedAt: turn.startedAt,
        ...(turn.finishedAt !== undefined ? { finishedAt: turn.finishedAt } : {}),
        memoryRevision: turn.dreamerReview!.memoryRevision,
      })),
      checkpoint: () => this.tree.dreamerCheckpoint(this.memory!.filePath),
      saveCheckpoint: (turnIds, checkpoint, signal) => this.tree.checkpointDreamer(this.memory!.filePath, turnIds, checkpoint, signal),
      protectedWritePaths: this.protectedWritePaths,
      ...(options.dreamer?.maxSteps !== undefined ? { maxSteps: options.dreamer.maxSteps } : {}),
      ...(options.dreamer?.idleTurns !== undefined ? { idleTurns: options.dreamer.idleTurns } : {}),
      ...(options.dreamer?.idleMs !== undefined ? { idleMs: options.dreamer.idleMs } : {}),
      ...(options.dreamer?.maxWaitMs !== undefined ? { maxWaitMs: options.dreamer.maxWaitMs } : {}),
      ...(options.dreamer?.maxRuntimeMs !== undefined ? { maxRuntimeMs: options.dreamer.maxRuntimeMs } : {}),
      onEvent: runtimeEventSink({ executionId: "dreamer", agentId: "dreamer", sessionId: null, turnId: null },
        (event) => this.publish(event), () => this.captureModelContent(), () => this.promptCacheDiagnostics()),
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
    const resources = await openRuntimeResources(options);
    try {
      const runtime = new ThreadRuntime(options, resources);
      await runtime.tasks.initialize();
      // Restore intent, not automatic side effects. File-rewind recovery has already finished.
      for (const [sessionId, goal] of runtime.tree.projection.goals) {
        if (goal.status === "active") await runtime.saveGoal(sessionId, {
          ...goal, status: "paused", reason: "Session restored; resume the goal explicitly.", updatedAt: Date.now(),
        });
      }
      runtime.dreamer?.start();
      return runtime;
    } catch (error) {
      await Promise.allSettled([resources.recall?.close(), resources.taskRepository.close(), resources.repository.close()]);
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
  get workerEnabled() { return this.tasks.enabled; }
  get dreamerEnabled() { return this.dreamer?.enabled ?? false; }
  get dreamerLastError() { return this.dreamer?.lastError; }
  get dreamerStatus() { return this.dreamer?.status; }
  get workerModel() { return this.secondaryModel(WORKER_PROFILE_ID); }
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
    const running = this.tree.projection.runningTurnsBySession.get(session.id);
    return structuredClone({ session, liveTipTurnId: this.tree.projection.liveTips.get(session.id) ?? null,
      turns, entries: turns.flatMap((turn) => this.tree.projection.entriesByTurn.get(turn.id) ?? []),
      tasks: turns.flatMap((turn) => this.agentTaskDetailsForTurn(turn.id)),
      activeTurn: running ? { turn: running, entries: this.tree.projection.entriesByTurn.get(running.id) ?? [],
        tasks: this.agentTaskDetailsForTurn(running.id) } : null });
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
      this.publish({ executionId: session.id, agentId: "main", timestamp: Date.now(), type: "session_changed", sessionId: session.id, turnId: null, liveTipTurnId: null, reason: "new" });
      return session;
    });
  }

  /** Records the session to reopen next time, without redirecting explicit prompt targets. */
  openSession(sessionId: string, options: { signal?: AbortSignal } = {}) {
    return this.operate(sessionId, options.signal, async (signal) => {
      signal.throwIfAborted();
      const session = await this.tree.openSession(sessionId);
      const liveTipTurnId = this.tree.projection.liveTips.get(session.id) ?? null;
      this.publish({ executionId: session.id, agentId: "main", timestamp: Date.now(), type: "session_changed", sessionId: session.id, turnId: liveTipTurnId, liveTipTurnId, reason: "opened" });
      return session;
    });
  }

  searchHistory(sessionId: string, queries: readonly string[], options: { limit?: number; signal?: AbortSignal } = {}) {
    return this.operate(sessionId, options.signal, (signal) => {
      if (!this.recallService) throw new Error("Session recall is disabled");
      return this.recallService.search(this.tree.resolveSession(sessionId).id, queries, options.limit ?? 8, signal);
    });
  }

  prompt(sessionId: string, input: string, options: PromptOptions = {}): Promise<TurnResult> {
    return this.operate(sessionId, options.signal, async (signal) => {
      const session = this.tree.resolveSession(sessionId);
      if (!this.model) throw new Error("No model configured");
      if (options.images?.length && this.model.acceptsImages !== true) throw new Error("Current model does not accept images");
      const runner = this.createAgentRunner(session.id);
      const dreamerReview = await this.dreamer?.admission(signal);
      signal.throwIfAborted();
      return runner.run(input, { ...this.runOptions(session.id, signal, options),
        ...(dreamerReview ? { dreamerReview } : {}) });
    }, true);
  }

  readGoal(sessionId: string): SessionGoal | undefined {
    this.assertOpen();
    return this.tree.readGoal(this.tree.resolveSession(sessionId).id);
  }

  /** One foreground operation owns all goal turns. Ordinary prompt() remains a single turn. */
  runGoal(sessionId: string, objective: string | undefined, options: GoalOptions = {}): Promise<TurnResult> {
    let goal: SessionGoal;
    let id: string;
    const maxTurns = options.maxTurns ?? DEFAULT_GOAL_MAX_TURNS;
    // Capture mutable public options before asynchronous admission.
    const images = options.images ? structuredClone(options.images) : undefined;
    const onEvent = options.onEvent;
    try {
      this.assertIdle();
      id = this.tree.resolveSession(sessionId).id;
      if (!this.model) throw new Error("No model configured");
      if (images?.length && this.model.acceptsImages !== true) throw new Error("Current model does not accept images");
      if (this.toolRegistry.get(GOAL_TOOL_NAME)) throw new Error(`Goal mode reserves the tool name ${GOAL_TOOL_NAME}`);
      if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new RangeError("maxTurns must be a positive safe integer");
      const previous = this.tree.readGoal(id);
      const now = Date.now();
      if (objective === undefined) {
        if (!previous || previous.status === "completed") throw new Error("No unfinished goal to resume");
        goal = { ...previous, status: "active", turnLimit: previous.turnsUsed + maxTurns, updatedAt: now };
        delete goal.reason;
      } else {
        if (!objective.trim() || objective.length > 4000) throw new Error("Goal must contain between 1 and 4000 characters");
        goal = { id: createId("goal"), objective, status: "active", turnsUsed: 0, turnLimit: maxTurns, createdAt: now, updatedAt: now };
      }
      if (!Number.isSafeInteger(goal.turnLimit)) throw new RangeError("Goal turn limit is too large");
    } catch (error) { return Promise.reject(error); }
    return this.operate(id, options.signal, async (signal) => {
      let first = true;
      let idleTurns = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          // The tool reports intent; only a successfully settled turn may commit its outcome.
          const reported: { decision?: GoalDecision; callId?: string } = {};
          const tool = createGoalTool(goal.id, (report, context) => {
            const running = this.tree.projection.runningTurnsBySession.get(id);
            if (running?.id !== context.invocation.turnId || running?.goalId !== goal.id ||
                this.tree.readGoal(id)?.id !== goal.id) throw new Error("This goal is no longer current");
            if (this.tasks.summariesForTurn(running.id).some((task) => task.status === "running")) {
              throw new Error("Wait for or cancel running workers before reporting a goal outcome");
            }
            reported.decision = report;
            reported.callId = context.invocation.toolCallId;
          });
          const runner = this.createAgentRunner(id, { state: goal, tool });
          const dreamerReview = await this.dreamer?.admission(signal);
          signal.throwIfAborted();
          const input = first && objective !== undefined ? goal.objective
            : "[Automatic goal continuation]\nContinue working toward the active goal. Preserve its original scope and permissions. Report completed or blocked through update_goal when appropriate.";
          const result = await runner.run(input, {
            ...this.runOptions(id, signal, {
              ...(onEvent ? { onEvent } : {}), ...(first && images ? { images } : {}),
            }),
            goal, ...(dreamerReview ? { dreamerReview } : {}),
          });
          const current = this.tree.readGoal(id);
          if (!current || current.id !== goal.id) throw new Error("The goal changed during execution");
          goal = current;
          if (result.outcome !== "completed" || signal.aborted) {
            await this.saveGoal(id, { ...goal, status: "paused", updatedAt: Date.now(),
              reason: result.error?.message ?? String(signal.reason ?? `Turn ${result.outcome}`) }, onEvent);
            return result;
          }
          const messages = this.tree.messagesForTurn(result.turn.id);
          const lastCall = messages.flatMap((message) => message.role === "assistant"
            ? message.content.filter((part) => part.type === "toolCall") : []).at(-1);
          // More tool work after a report invalidates it, including newly delegated workers.
          if (reported.decision && lastCall?.name === GOAL_TOOL_NAME && lastCall.id === reported.callId) {
            await this.saveGoal(id, { ...goal, ...reported.decision, updatedAt: Date.now() }, onEvent, signal);
            return result;
          }
          const hadToolResult = messages.some((message) =>
            message.role === "toolResult" && message.toolName !== GOAL_TOOL_NAME && !message.isError);
          idleTurns = hadToolResult ? 0 : idleTurns + 1;
          if (goal.turnsUsed >= goal.turnLimit || idleTurns >= 3) {
            await this.saveGoal(id, { ...goal, status: "paused", updatedAt: Date.now(), reason: idleTurns >= 3
              ? "Three consecutive turns without a successful work tool call; review the goal before resuming."
              : "Turn budget reached; resume explicitly to allow more turns." }, onEvent);
            return result;
          }
          first = false;
          // Let cancellation/input reach the owner before admitting another turn, even with synchronous models.
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } catch (error) {
        const current = this.tree.readGoal(id);
        if (current?.id === goal.id && current.status === "active") {
          await this.saveGoal(id, { ...current, status: "paused", updatedAt: Date.now(),
            reason: error instanceof Error ? error.message : String(error) }, onEvent);
        }
        throw error;
      }
    }, true, goal.id);
  }

  async pauseGoal(sessionId: string): Promise<void> {
    this.assertOpen();
    const id = this.tree.resolveSession(sessionId).id;
    const active = this.active;
    if (active?.sessionId === id && active.goalId) {
      active.controller.abort(new DOMException("Goal paused by user", "AbortError"));
      await this.settleCancellation(active);
      return;
    }
    await this.operate(id, undefined, async () => {
      const goal = this.tree.readGoal(id);
      if (goal && goal.status !== "completed") await this.saveGoal(id, {
        ...goal, status: "paused", reason: "Paused by user.", updatedAt: Date.now(),
      });
    });
  }

  async clearGoal(sessionId: string): Promise<void> {
    this.assertOpen();
    const id = this.tree.resolveSession(sessionId).id;
    const expected = this.active?.sessionId === id && this.active.goalId
      ? this.active.goalId : this.tree.readGoal(id)?.id;
    await this.pauseGoal(id);
    await this.operate(id, undefined, async () => {
      const goal = this.tree.readGoal(id);
      if (goal && goal.id !== expected) throw new Error("The goal changed before it could be cleared");
      await this.saveGoal(id, null);
    });
  }

  private async saveGoal(sessionId: string, goal: SessionGoal | null, onEvent?: RuntimeEventSink, signal?: AbortSignal): Promise<void> {
    await this.tree.setGoal(sessionId, goal, signal);
    this.publishGoal(sessionId, onEvent);
  }

  private publishGoal(sessionId: string, onEvent?: RuntimeEventSink): void {
    const event: RuntimeEvent = { type: "goal_changed", sessionId, turnId: null, executionId: sessionId,
      agentId: "main", timestamp: Date.now(), goal: this.tree.readGoal(sessionId) ?? null };
    this.publish(event);
    safeRuntimeEvent(onEvent, event);
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
      return this.createAgentRunner(session.id).compactCurrent(this.runOptions(session.id, signal, options));
    });
  }

  rewind(sessionId: string, turnIdOrUserEntryId: string, options: RewindOptions = {}) {
    return this.operate(sessionId, options.signal, async (signal) => {
      const session = this.tree.resolveSession(sessionId);
      const candidate = this.tree.resolveRewindCandidate(turnIdOrUserEntryId, session.id);
      const livePath = this.tree.livePath(session.id);
      signal.throwIfAborted();
      const turn = this.tree.projection.turns.get(candidate.turnId)!;
      // Once admitted, restoration ignores cancellation. An interrupted restore
      // retains its durable intent and is completed when the project reopens.
      if (options.restoreFiles ?? this.fileCheckpoints) {
        await this.files.rewind(livePath.slice(livePath.findIndex((item) => item.id === candidate.turnId)));
      } else {
        await this.tree.moveLiveTipForRewind(turn.parentTurnId, session.id);
      }
      this.publish({ executionId: session.id, agentId: "main", timestamp: Date.now(), type: "session_changed", sessionId: session.id, turnId: turn.parentTurnId,
        liveTipTurnId: turn.parentTurnId, reason: "rewind" });
      this.publishGoal(session.id);
      return candidate;
    });
  }

  rewindCandidates(sessionId: string) {
    this.assertOpen();
    return this.tree.rewindCandidates(this.tree.resolveSession(sessionId).id);
  }

  contextMessages(sessionId: string): Message[] {
    this.assertOpen();
    return this.builder.build({ sessionId: this.tree.resolveSession(sessionId).id }).messages;
  }

  contextUsage(sessionId: string) {
    return this.contextSnapshot(sessionId).usage;
  }

  /** Build messages and their usage together so clients need only one context projection. */
  contextSnapshot(sessionId: string) {
    this.assertOpen();
    const session = this.tree.resolveSession(sessionId);
    const messages = this.builder.build({ sessionId: session.id }).messages;
    if (!this.model) return { messages, usage: undefined };
    const { requestTokens } = contextBudget({
      systemPrompt: this.systemPromptFor(session.id),
      messages: this.model.acceptsImages ? messages : messages.map(messageWithoutImages),
      tools: this.toolRegistry.modelDefinitions(),
    }, messages);
    return { messages, usage: { requestTokens, contextWindow: this.model.contextWindow } };
  }

  subscribe(listener: RuntimeEventSink, options: RuntimeSubscriptionOptions = {}): () => void {
    this.assertOpen();
    this.listeners.set(listener, { ...options });
    this.promptCacheDiagnostics();
    return () => {
      this.listeners.delete(listener);
      this.promptCacheDiagnostics();
    };
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

  /** Execution transforms for the main agent only. Policies and subscriptions cover all agents. */
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

  configureAgent(id: typeof WORKER_PROFILE_ID | typeof DREAMER_PROFILE_ID, enabled: boolean, model?: ModelClient): void {
    this.assertIdle();
    if (id !== WORKER_PROFILE_ID && id !== DREAMER_PROFILE_ID) throw new Error(`Unknown agent: ${id}`);
    const previous = this.secondaryModel(id);
    if (enabled) {
      if (!model) throw new Error("An enabled agent requires a model");
      if (id === DREAMER_PROFILE_ID && !this.dreamer) throw new Error("Dreamer requires globalMemoryPath");
      const profile = this.bindProfile(id === WORKER_PROFILE_ID
        ? createWorkerProfile(model, this.workerSettings)
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

  private operate<T>(sessionId: string | undefined, signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T> | T, resetsDreamerIdle = false, goalId?: string): Promise<T> {
    let resolvedSessionId: string | undefined;
    try {
      this.assertIdle();
      signal?.throwIfAborted();
      resolvedSessionId = sessionId ? this.tree.resolveSession(sessionId).id : undefined;
    } catch (error) { return Promise.reject(error); }
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const active: ActiveOperation = { ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
      ...(goalId ? { goalId } : {}), controller, signal: combined, done: Promise.resolve() };
    this.active = active;
    const backgroundSettled = this.dreamer?.foregroundStarting(resetsDreamerIdle);
    const done = Promise.resolve().then(async () => {
      await backgroundSettled;
      combined.throwIfAborted();
      return operation(combined);
    }).finally(() => {
      if (this.active === active) this.active = undefined;
      if (!this.closing) this.dreamer?.foregroundFinished(resetsDreamerIdle);
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
      this.cacheDiagnostics?.clear();
      this.cacheDiagnostics = undefined;
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

  private captureModelContent(): boolean {
    return [...this.listeners.values()].some((options) => options.captureModelContent);
  }

  private promptCacheDiagnostics(): PromptCacheDiagnostics | undefined {
    if ([...this.listeners.values()].some((options) => options.promptCacheDiagnostics)) {
      return this.cacheDiagnostics ??= new PromptCacheDiagnostics();
    }
    this.cacheDiagnostics?.clear();
    this.cacheDiagnostics = undefined;
    return undefined;
  }

  private publish(event: RuntimeEvent): void {
    for (const [listener, options] of this.listeners) {
      if (event.type === "model_cache_diagnostic" && !options.promptCacheDiagnostics) continue;
      safeRuntimeEvent(listener, options.captureModelContent ? event : withoutModelContent(event));
    }
  }

  private remember(state: ThreadState): void {
    this.state = state;
    this.options.onStateChange?.(structuredClone(state));
  }

  private secondaryModel(id: typeof WORKER_PROFILE_ID | typeof DREAMER_PROFILE_ID) {
    const profile = this.profiles.get(id);
    if (profile) return { provider: profile.model.providerId, id: profile.model.modelId };
    return this.state.agents?.[id]?.model ?? (id === WORKER_PROFILE_ID
      ? this.options.worker?.defaultModel : this.options.dreamer?.defaultModel);
  }

  private syncTaskTools(): void {
    if (!this.tasks.enabled) { for (const dispose of this.taskToolDisposers.splice(0)) dispose(); return; }
    if (this.taskToolDisposers.length) return;
    const tools = createAgentTaskTools(this.tasks);
    const conflict = tools.find((tool) => this.toolRegistry.get(tool.name));
    if (conflict) throw new Error(`Cannot enable workers because tool ${conflict.name} is already registered`);
    this.taskToolDisposers = tools.map((tool) => this.toolRegistry.register(tool));
  }

  private bindProfile(profile: AgentProfile): AgentProfile {
    const model = bindModel(profile.model, `${this.tree.tree.id}:${profile.id}`, this.options.cacheRetention);
    return { ...profile, model, systemPrompt: [profile.systemPrompt,
      profile.id === WORKER_PROFILE_ID ? this.options.sharedInstructions : undefined].filter(Boolean).join("\n\n") };
  }

  private createAgentRunner(sessionId: string, goal?: { state: SessionGoal; tool: AgentTool }): AgentRunner {
    if (!this.model) throw new Error("No model configured");
    const systemPrompt = [this.systemPromptFor(sessionId), goal ? goalPrompt(goal.state) : ""].filter(Boolean).join("\n\n");
    const tools = goal ? new ToolRegistry() : this.toolRegistry;
    if (goal) {
      for (const tool of this.toolRegistry.list()) tools.register(tool);
      tools.register(goal.tool);
    }
    return createAgentRunner({ model: this.model, ...(this.modelSelection.reasoning ? { reasoning: this.modelSelection.reasoning } : {}),
      rootPath: this.rootPath, systemPrompt, tree: this.tree, fileHistory: this.files, contextBuilder: this.builder,
      tools, extensions: this.extensions, agentTasks: this.tasks, askPresenter: () => this.askPresenter,
      writableExternalPaths: [...(this.options.writableExternalPaths ?? []), ...(this.memory ? [this.memory.filePath] : [])],
      writableExternalDirectories: this.options.writableExternalDirectories ?? [],
      protectedWritePaths: this.protectedWritePaths,
      ...(this.memory ? { globalMemoryPath: this.memory.filePath } : {}),
      ...(this.options.toolPolicy ? { toolPolicy: this.options.toolPolicy } : {}), profileId: MAIN_AGENT_PROFILE_ID });
  }

  /** Copy the public allowlist explicitly: JavaScript callers can still supply extra properties. */
  private runOptions(sessionId: string, signal: AbortSignal, options: PromptOptions): RunTurnOptions {
    return {
      sessionId, signal,
      ...(options.images ? { images: options.images } : {}),
      ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      captureModelContent: () => this.captureModelContent(),
      promptCacheDiagnostics: () => this.promptCacheDiagnostics(),
      onEvent: (event) => {
        this.publish(event);
        if (event.type !== "model_cache_diagnostic") safeRuntimeEvent(options.onEvent, withoutModelContent(event));
      },
    };
  }

  private systemPromptFor(sessionId: string): string {
    return [this.options.systemPrompt ?? "", this.options.appendSystemPrompt, this.options.sharedInstructions,
      this.tasks.enabled ? AGENT_TASK_ORCHESTRATION_PROMPT : "", formatSkillsSection(this.loadedSkills.skills),
      this.memory ? formatGlobalMemoryPrompt(this.memory.filePath, this.memory.snapshot(sessionId)) : ""].filter(Boolean).join("\n\n");
  }

}
