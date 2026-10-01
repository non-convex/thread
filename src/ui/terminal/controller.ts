import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ThreadApp } from "../../app/thread-app.js";
import { parseInput, type RoutedInput } from "../../app/input-router.js";
import type { CommandResult, EphemeralView } from "../../app/commands/types.js";
import { cacheHitPercent, latestCacheMissReason, scanCacheUsage } from "../../core/context/usage.js";
import { gitBranchName } from "./git.js";
import type { RuntimeEvent } from "../../core/runtime/events.js";
import { AskService } from "../../core/runtime/interaction.js";
import { UiEventBatcher, type UiEvent } from "../events.js";
import { composerImageContent, type ComposerImage } from "../images.js";
import {
  createUiState,
  filteredModels,
  isFloatingOverlay,
  openEphemeralView,
  type LiveBlock,
  type AskScreen,
  type UiScreen,
  type UiState,
} from "../state.js";
import { reduceUiEvent } from "../reducer.js";
import type { SlashSuggestion, TerminalKey, TerminalMeta, UiNotifyKind } from "./view-model.js";
import { projectTranscript } from "./transcript-projection.js";
import { handleAskKey, isEnter, printableKey } from "./ask-input.js";

export function primarySlashSuggestions(hasSkills: boolean, fileCheckpoints = false): SlashSuggestion[] {
  return [
    { name: "clear", description: "Clear the visible transcript" },
    { name: "compact", description: "Compact the current path's live context" },
    { name: "goal", description: "Enter a goal to work toward", submit: false },
    { name: "agent", description: "Configure agent models and background agents" },
    { name: "model", description: "Inspect or select the main model" },
    { name: "new", description: "Create an empty Session from the project Root" },
    { name: "session", description: "List or resume root Sessions" },
    { name: "schedule", description: "Browse schedules and open their Sessions" },
    { name: "mcp", description: "Inspect MCP servers; reconnect a server while idle" },
    ...(hasSkills ? [{ name: "skill", description: "List or invoke an installed skill" }] : []),
    { name: "thread", description: "Session Tree status, history, Sessions, and search" },
    { name: "rewind", description: fileCheckpoints ? "Undo built-in file edits and rewind the conversation" : "Rewind the conversation; keep workspace files" },
    { name: "exit", description: "Exit thread" },
  ];
}

type Listener = (kind: UiNotifyKind) => void;

interface InputViewOwner {
  sessionId: string;
  screen: UiScreen;
  generation: number;
  /** Defined for menu actions; false retains the parent when opening a child. */
  menuReplace?: boolean;
}

const RUNNING_INPUT_NOTICE = "This Session is running. Wait for the active turn or command to finish, or use /new or /session.";

function switchesSession(route: RoutedInput): boolean {
  return route.command === "new" || route.command === "session" ||
    ((route.command === "thread" || route.command === "schedule") && /^open(?:\s|$)/.test(route.rest));
}

function notifyKind(event: UiEvent): UiNotifyKind {
  switch (event.type) {
    case "command_started":
    case "command_finished":
      return "full";
    case "session_changed":
      return event.reason === "turn" ? "live" : "full";
    default:
      return "live";
  }
}

export class ThreadTuiController {
  readonly state: UiState;
  readonly meta: TerminalMeta;
  readonly slashSuggestions: readonly SlashSuggestion[];
  private readonly listeners = new Set<Listener>();
  private readonly viewHistory: UiScreen[] = [];
  private readonly batcher: UiEventBatcher;
  private readonly activeInputs = new Map<string, AbortController>();
  /** Each running Session retains its deltas while another Session is selected. */
  private readonly liveViews = new Map<string, UiState>();
  private readonly inputControllers = new Set<AbortController>();
  private historyDirty = true;
  private stopped = false;
  private lastCtrlC = 0;
  private idleExitTimer: NodeJS.Timeout | undefined;
  private gitGeneration = 0;
  private viewGeneration = 0;
  private readonly questions = new Map<string, { service: AskService; screen?: AskScreen }>();
  private readonly detachAsk: () => void;
  private readonly detachRuntime: () => void;
  private disposed = false;
  private resolveDone: (() => void) | undefined;
  private readonly donePromise: Promise<void>;

  constructor(private readonly app: ThreadApp) {
    this.slashSuggestions = primarySlashSuggestions(app.runtime.skills.length > 0, app.runtime.fileCheckpoints);
    const session = app.runtime.readSession(app.selectedSessionId);
    this.state = createUiState(session.session.id, session.liveTipTurnId, []);
    this.state.goal = app.runtime.readGoal(session.session.id);
    for (const sessionId of app.runtime.activeSessionIds) this.recoverLiveView(sessionId);
    this.state.busy = this.runtimeBusy;
    const settings = app.runtime.getModelSettings(session.session.id);
    const displayed = settings.active ?? settings;
    this.meta = {
      rootPath: app.runtime.rootPath,
      modelName: displayed.model?.modelId ?? "no model",
      thinkingLevel: displayed.thinkingLevel,
      supportsThinking: settings.active ? settings.active.model.reasoning === true : settings.supportsThinking,
      nextModelSettings: undefined,
      contextPercent: 0,
      cacheHitPercent: null,
      cacheMissedTokens: 0,
      cacheMissReason: null,
      gitBranch: undefined,
      acceptsImages: settings.model?.acceptsImages === true,
    };
    this.donePromise = new Promise<void>((resolve) => { this.resolveDone = resolve; });
    this.batcher = new UiEventBatcher((events) => this.applyUiEvents(events));
    this.detachRuntime = app.runtime.subscribe((event) => this.receiveRuntimeEvent(event));
    this.detachAsk = app.runtime.setAskPresenter({ present: (request, signal) => {
      if (this.stopped || this.disposed) return Promise.reject(new DOMException("Aborted", "AbortError"));
      return this.askForSession(request.invocation?.sessionId ?? this.app.selectedSessionId).present(request, signal);
    } });
    this.syncTranscript();
    this.refreshMeta();
    this.refreshGit();
    if (app.runtime.agentProfileDiagnostics.length) {
      this.state.notice = {
        level: app.runtime.agentProfileDiagnostics.some((item) => item.level === "error") ? "error" : "info",
        text: app.runtime.agentProfileDiagnostics.map((item) => `${item.profileId}: ${item.message}`).join(" · "),
      };
    }
    this.showLiveView();
  }

  get isStopped(): boolean { return this.stopped; }

  private get active(): AbortController | undefined { return this.activeInputs.get(this.app.selectedSessionId); }
  private get runtimeBusy(): boolean { return this.app.runtime.sessionBusy(this.app.selectedSessionId); }
  private get ask(): AskService { return this.askForSession(this.app.selectedSessionId); }

  private askForSession(sessionId: string): AskService {
    let entry = this.questions.get(sessionId);
    if (entry) return entry.service;
    entry = { service: new AskService() };
    this.questions.set(sessionId, entry);
    const questions = entry;
    questions.service.subscribe((request) => {
      if (this.stopped || this.disposed) return;
      if (request && questions.screen?.request.id !== request.id) {
        questions.screen = { type: "ask", request, questionIndex: 0,
          chosen: request.questions.map(() => []), answers: [], selected: 0, customText: undefined };
      } else if (!request) delete questions.screen;
      if (sessionId === this.app.selectedSessionId) {
        this.showQuestion();
        this.notify();
      }
    });
    return questions.service;
  }

  private showQuestion(): void {
    const screen = this.questions.get(this.app.selectedSessionId)?.screen;
    if (screen && this.state.screen !== screen) {
      this.state.screen = screen;
      this.viewGeneration++;
    } else if (!screen && this.state.screen.type === "ask") {
      this.state.screen = { type: "session" };
      this.viewGeneration++;
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitUntilStopped(): Promise<void> { return this.donePromise; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.inputControllers) controller.abort(new DOMException("Aborted", "AbortError"));
    this.detachRuntime();
    this.batcher.dispose();
    if (this.idleExitTimer) clearTimeout(this.idleExitTimer);
    for (const questions of this.questions.values()) questions.service.dispose();
    this.detachAsk();
    this.listeners.clear();
  }

  requestStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelIdleExitGesture();
    this.detachRuntime();
    for (const controller of this.inputControllers) controller.abort(new DOMException("Aborted", "AbortError"));
    this.resolveDone?.();
    this.notify();
  }

  interrupt(): boolean {
    if (this.stopped || this.disposed) return false;
    const target = this.app.selectedSessionId;
    if (this.app.runtime.activeSessionIds.includes(target)) {
      void this.app.runtime.interrupt(target).catch(() => undefined);
      return true;
    }
    if (this.active) {
      this.active.abort(new DOMException("Aborted", "AbortError"));
      return true;
    }
    return false;
  }

  idleCtrlC(): boolean {
    const now = Date.now();
    if (now - this.lastCtrlC < 1_000) {
      this.requestStop();
      return true;
    }
    this.lastCtrlC = now;
    this.state.notice = { level: "info", text: "Press Ctrl+C again to exit" };
    this.idleExitTimer = setTimeout(() => {
      this.state.notice = undefined;
      this.notify();
    }, 1_100);
    this.notify();
    return false;
  }

  cancelIdleExitGesture(): void {
    this.lastCtrlC = 0;
    if (this.idleExitTimer) clearTimeout(this.idleExitTimer);
    this.idleExitTimer = undefined;
  }

  note(text: string, level: "info" | "success" | "error" = "info"): void {
    this.state.notice = { level, text };
    this.notify();
  }

  cycleThinkingLevel(): void {
    if (this.stopped || this.disposed) return;
    let level: ModelThinkingLevel | undefined;
    try {
      // Preferences apply to the next turn, even while this turn is running.
      level = this.app.runtime.cycleThinkingLevel(this.app.selectedSessionId);
    } catch (error) {
      this.note(error instanceof Error ? error.message : String(error), "error");
      return;
    }
    if (!level) return;
    this.refreshMeta();
    const active = this.app.runtime.getModelSettings(this.app.selectedSessionId).active;
    this.state.notice = { level: "info", text: `Thinking${active ? " (next turn)" : ""}: ${level}` };
    this.notify();
  }

  closeView(): void {
    this.viewGeneration++;
    if (this.state.screen.type === "ask") {
      this.ask.dismiss(this.state.screen.request.id);
    } else {
      this.state.screen = this.viewHistory.pop() ?? { type: "session" };
      this.state.notice = undefined;
    }
    this.showQuestion();
    this.notify();
  }

  selectAskOption(index: number | undefined): void {
    const screen = this.state.screen;
    if (screen.type !== "ask") return;
    if (index === undefined) screen.customText ??= "";
    else {
      screen.selected = index;
      screen.customText = undefined;
    }
    this.notify();
  }

  handleScreenKey(key: TerminalKey): boolean {
    const screen = this.state.screen;
    const enter = isEnter(key);
    if (screen.type === "ask") {
      handleAskKey(screen, key, this.ask);
      this.notify();
      return true;
    }
    if (!isFloatingOverlay(screen)) return false;
    if (screen.busy) return true;
    if (screen.type === "model_picker") {
      const typed = printableKey(key);
      if (typed || key.name === "backspace") {
        screen.filter = typed ? screen.filter + typed : [...screen.filter].slice(0, -1).join("");
        screen.selected = 0;
        screen.error = undefined;
        this.notify("live");
        return true;
      }
      if (enter) {
        void this.advanceModelPicker();
        return true;
      }
    }
    if (!enter) return false;
    if (screen.type === "command_picker") {
      const item = screen.items[screen.selected];
      if (item?.submit) void this.runScreenCommand(item.command);
      else if (item) {
        this.openView({ type: "composer", text: item.command, hint: "Add any instructions, then press Enter to run." });
        this.notify();
      }
    } else if (screen.type === "agent_picker") {
      const agent = screen.agents[screen.selected];
      if (agent) void this.runScreenCommand(`/agent ${agent.id}`);
    } else if (screen.type === "agent_settings") {
      const action = ["off", "on", "model"][screen.selected];
      if (action) void this.runScreenCommand(`/agent ${screen.agentId} ${action}`);
    } else if (screen.type === "rewind") {
      const item = screen.items[screen.selected];
      if (item && !screen.confirm) {
        screen.confirm = true;
        this.notify();
      } else if (item) void this.runScreenCommand(`/rewind ${item.turnId}`);
    }
    return true;
  }

  /** Returns acceptance synchronously; the draft may be cleared without waiting for the operation. */
  submit(raw: string, images: readonly ComposerImage[] = []): boolean {
    const done = this.executeInput(raw, images);
    if (!done) return false;
    this.viewHistory.length = 0;
    void done;
    return true;
  }

  private executeInput(raw: string, images: readonly ComposerImage[] = [], menuAction?: { replace: boolean }): Promise<boolean> | undefined {
    const input = /^\s*\/goal(?:\s|$)/.test(raw) ? raw.trimStart() : raw.trim();
    if ((!input && images.length === 0) || this.stopped || this.disposed) return undefined;
    const route = parseInput(input);
    const foreground = route.category === "work" && !this.active && !this.state.busy;
    if (!this.app.canHandleInput(route, Boolean(this.active || this.state.busy)) || (!foreground && images.length > 0)) {
      this.note(RUNNING_INPUT_NOTICE, "error");
      return undefined;
    }
    if (input === "/exit") {
      this.requestStop();
      return Promise.resolve(true);
    }
    const imageBlocks = images.map(composerImageContent);
    if (imageBlocks.length > 0 && this.app.runtime.getModelSettings(this.app.selectedSessionId).model?.acceptsImages !== true) {
      this.note("Current model does not accept images. Use /model to pick a vision model.", "error");
      return undefined;
    }
    const controller = new AbortController();
    const sessionId = this.app.selectedSessionId;
    const owner: InputViewOwner = { sessionId, screen: this.state.screen, generation: ++this.viewGeneration,
      ...(menuAction ? { menuReplace: menuAction.replace } : {}) };
    this.inputControllers.add(controller);
    if (foreground) {
      this.activeInputs.set(sessionId, controller);
      // Reserve UI input before the router emits turn/command events.
      this.state.busy = true;
      this.state.activity = input.startsWith("/") ? `running ${input.split(/\s/, 1)[0]}` : "preparing";
      this.state.notice = undefined;
      this.state.modelRetryError = undefined;
      this.state.turnStartedAt = undefined;
      this.state.turnFinishedAt = undefined;
      this.notify("live");
    }
    return this.finishInput(route, imageBlocks, controller, foreground, owner);
  }

  private async finishInput(route: RoutedInput, imageBlocks: ReturnType<typeof composerImageContent>[], controller: AbortController, foreground: boolean, owner: InputViewOwner): Promise<boolean> {
    const { sessionId } = owner;
    try {
      const result = await this.app.handleInput(route, {
        signal: controller.signal,
        onCommandEvent: (event) => {
          if (!this.stopped && !this.disposed && foreground && sessionId === this.app.selectedSessionId &&
              (event.type === "command_started" || event.type === "command_finished")) {
            this.batcher.push(event);
          }
        },
        ...(imageBlocks.length > 0 ? { images: imageBlocks } : {}),
      });
      if (this.stopped || this.disposed) return true;
      this.batcher.flush();
      // Check ownership before syncing a Session switch caused by this command itself.
      const ownsView = owner.generation === this.viewGeneration && owner.screen === this.state.screen &&
        sessionId === this.state.sessionId;
      const historyChanged = this.syncTranscript();
      this.showLiveView();
      if (historyChanged || (result.kind === "command" && result.result.changedState)) this.refreshMeta();
      if (result.kind === "command") {
        const navigated = switchesSession(route) && result.result.changedState;
        const canPresentView = ownsView && (sessionId === this.app.selectedSessionId || navigated) &&
          !this.questions.get(this.app.selectedSessionId)?.screen;
        this.presentCommand(result.result, owner, canPresentView, navigated);
      }
      return true;
    } catch (error) {
      if (this.stopped || this.disposed) return false;
      this.batcher.flush();
      // A failed input may have persisted messages without reaching turn_finished.
      if (foreground && sessionId === this.app.selectedSessionId) this.historyDirty = true;
      this.syncTranscript();
      this.showLiveView();
      const message = error instanceof Error ? error.message : String(error);
      this.state.notice = { level: "error", text: sessionId === this.app.selectedSessionId ? message : `Session ${sessionId}: ${message}` };
      if (owner.menuReplace !== undefined && isFloatingOverlay(owner.screen)) owner.screen.error = message;
      return false;
    } finally {
      this.inputControllers.delete(controller);
      if (this.activeInputs.get(sessionId) === controller) this.activeInputs.delete(sessionId);
      if (!this.stopped && !this.disposed) {
        if (foreground) {
          if (sessionId === this.app.selectedSessionId && this.state.turnStartedAt !== undefined && this.state.turnFinishedAt === undefined) {
            this.state.turnFinishedAt = Date.now();
          }
          this.refreshGit();
        }
        this.state.busy = this.runtimeBusy || Boolean(this.active);
        this.showLiveView();
        this.refreshModelMeta();
        this.notify();
      }
    }
  }

  private receiveRuntimeEvent(event: RuntimeEvent): void {
    if (this.stopped || this.disposed) return;
    if (event.type === "goal_changed" && event.agentId !== "main") return;
    if (event.type === "dreamer_status") {
      this.batcher.push(event);
      return;
    }
    if (event.type === "runtime_status") {
      this.batcher.push(event);
      return;
    }
    if (event.type === "model_call_started" || event.type === "model_call_finished" ||
        event.type === "model_attempt_started" || event.type === "model_attempt_finished" ||
        ((event.type === "agent_run_started" || event.type === "agent_run_finished") && !event.taskId)) return;
    if (event.taskId && event.type !== "agent_task_created" && event.type !== "agent_task_updated" && event.type !== "context_updated") {
      this.batcher.push({ type: "agent_task_trace", taskId: event.taskId, sessionId: event.sessionId, event });
      return;
    }
    this.batcher.push(event.type === "context_updated"
      ? { type: "context_updated", sessionId: event.sessionId,
          percent: Math.min(999, Math.round(event.estimatedTokens / event.contextWindow * 100)) }
      : event);
  }

  private applyUiEvents(events: readonly UiEvent[]): void {
    if (this.stopped || this.disposed) return;
    let kind: UiNotifyKind = "live";
    let modelChanged = false;
    for (const event of events) {
      try {
        if ((event.type === "runtime_status" || event.type === "turn_preparing" || event.type === "turn_started" ||
            event.type === "turn_finished") && event.sessionId === this.app.selectedSessionId) modelChanged = true;
        if (event.type === "runtime_status") {
          if (event.busy && event.sessionId && !this.liveViews.has(event.sessionId)) {
            const view = createUiState(event.sessionId, null, []);
            view.activity = "preparing";
            this.liveViews.set(event.sessionId, view);
            if (event.sessionId === this.app.selectedSessionId) this.state.notice = undefined;
          }
          if (!event.busy && event.sessionId) {
            const view = this.liveViews.get(event.sessionId);
            // Admission can end without a turn_started/turn_finished pair.
            if (view && event.sessionId === this.app.selectedSessionId) {
              const pending = view.liveTurn?.id.startsWith("pending:");
              this.state.turnStartedAt = pending ? undefined : view.turnStartedAt;
              this.state.turnFinishedAt = pending ? undefined : view.turnFinishedAt;
            }
            this.liveViews.delete(event.sessionId);
          }
        } else if (event.type === "command_started" || event.type === "command_finished") {
          if (!this.runtimeBusy && !this.active) reduceUiEvent(this.state, event);
        } else if (event.type === "dreamer_status") {
          reduceUiEvent(this.state, event);
        } else if (event.type === "goal_changed") {
          if (event.sessionId === this.app.selectedSessionId) reduceUiEvent(this.state, event);
        } else if (event.type === "session_changed") {
          if (event.sessionId === this.app.selectedSessionId && event.reason !== "turn") this.historyDirty = true;
        } else if (event.type === "context_updated") {
          if (event.sessionId === this.app.selectedSessionId) this.meta.contextPercent = event.percent;
        } else {
          if ((event.type === "turn_preparing" || event.type === "turn_started") && !this.liveViews.has(event.sessionId)) {
            this.liveViews.set(event.sessionId, createUiState(event.sessionId, null, []));
          }
          const view = event.sessionId ? this.liveViews.get(event.sessionId) : undefined;
          if (view) {
            reduceUiEvent(view, event);
            if (event.type === "turn_finished") {
              if (event.sessionId === this.app.selectedSessionId && view.notice) {
                this.state.notice = view.notice;
              } else if (event.sessionId !== this.app.selectedSessionId) {
                this.state.notice = { level: event.outcome === "failed" ? "error" : "info",
                  text: `Turn ${event.outcome} in Session ${event.sessionId}. Open it with /session ${event.sessionId}.` };
              }
              // The committed turn is now owned by the durable projection. Goal
              // runs can immediately start another turn in this same live view.
              view.liveTurn = undefined;
              view.activity = "preparing";
              if (event.sessionId === this.app.selectedSessionId) this.historyDirty = true;
            }
            if (event.type === "compaction_finished" && event.reason === "manual" && event.ok && event.entryId &&
                event.sessionId === this.app.selectedSessionId) this.historyDirty = true;
          }
        }
        if (notifyKind(event) === "full") kind = "full";
      } catch {
        // One malformed presentation event must not discard the rest of its frame.
      }
    }
    const historyChanged = this.syncTranscript();
    if (historyChanged || modelChanged) this.refreshMeta();
    if (historyChanged) kind = "full";
    this.state.busy = this.runtimeBusy || Boolean(this.active);
    this.showLiveView();
    if (events.length) this.notify(kind);
  }

  private presentCommand(result: CommandResult, owner: InputViewOwner, canPresentView: boolean, navigated: boolean): void {
    if (result.presentation === "clear") {
      // /clear affects only the selected Session's visible transcript, not its live turn or history.
      if (owner.sessionId === this.app.selectedSessionId) this.state.transcript = [];
    } else if (result.view) {
      if (canPresentView) {
        if (owner.menuReplace === false && isFloatingOverlay(owner.screen) && result.view.type !== "composer") {
          this.viewHistory.push(owner.screen);
        }
        this.openView(result.view);
        if (owner.menuReplace && owner.screen.type === "model_picker" && this.state.screen.type === "model_picker") {
          this.state.screen.filter = owner.screen.filter;
          this.state.screen.selected = 0;
        }
      }
      return;
    }
    if (canPresentView && owner.menuReplace !== undefined) {
      this.state.screen = { type: "session" };
      this.viewHistory.length = 0;
      this.viewGeneration++;
    }
    // Even an obsolete menu action must report its success without reopening the old view.
    if (result.content && result.presentation !== "clear") {
      const text = owner.sessionId === this.app.selectedSessionId || navigated
        ? result.content : `Session ${owner.sessionId}: ${result.content}`;
      this.state.notice = { level: "success", text };
    }
  }

  private openView(view: EphemeralView): void {
    if (this.questions.get(this.app.selectedSessionId)?.screen) {
      this.showQuestion();
      return;
    }
    this.viewGeneration++;
    if (view.type === "composer") {
      this.state.composerInput = view.text;
      this.state.screen = { type: "session" };
      this.state.notice = { level: "info", text: view.hint };
      this.viewHistory.length = 0;
    } else openEphemeralView(this.state, view);
  }

  /** Menu navigation keeps the parent and its selection; successful actions close it. */
  private async runScreenCommand(command: string, replace = false): Promise<void> {
    const screen = this.state.screen;
    if (!isFloatingOverlay(screen) || screen.busy || this.stopped || this.disposed) return;
    screen.busy = true;
    screen.error = undefined;
    this.notify();
    const execution = this.executeInput(command, [], { replace });
    if (!execution) {
      screen.busy = false;
      screen.error = this.state.notice?.text ?? "Command unavailable";
      if (screen.type === "rewind") screen.confirm = false;
      this.notify();
      return;
    }
    const succeeded = await execution;
    if (this.stopped || this.disposed) return;
    screen.busy = false;
    if (!succeeded) {
      screen.error ??= "Command failed";
      if (screen.type === "rewind") screen.confirm = false;
    }
    this.notify();
  }

  private async advanceModelPicker(): Promise<void> {
    const screen = this.state.screen;
    if (screen.type !== "model_picker") return;
    const models = filteredModels(screen);
    const model = models[screen.selected];
    const command = `/agent ${screen.agentId} model`;
    if (model) {
      await this.runScreenCommand(`${command} ${JSON.stringify(`${model.providerId}/${model.modelId}`)}`);
    } else if (screen.selected === models.length) {
      await this.runScreenCommand(`${command}${screen.scope === "configured" ? " all" : ""}`, true);
    }
  }

  private recoverLiveView(sessionId: string): void {
    if (this.liveViews.has(sessionId)) return;
    const view = createUiState(sessionId, null, []);
    const running = this.app.runtime.readSession(sessionId).activeTurn;
    if (running) {
      const { turn, entries, tasks } = running;
      const projected = projectTranscript(entries, tasks);
      const user = projected.find((item) => item.id === `${turn.id}:user`);
      view.turnStartedAt = turn.startedAt;
      view.liveTurn = { id: turn.id, sessionId, input: user?.content ?? "", startedAt: turn.startedAt,
        blocks: projected.filter((item): item is LiveBlock => item.kind !== "user" && item.kind !== "interrupted") };
      view.activity = "thinking";
    } else view.activity = "preparing";
    this.liveViews.set(sessionId, view);
  }

  private showLiveView(): void {
    const view = this.liveViews.get(this.app.selectedSessionId);
    if (view) {
      // A navigation snapshot may already contain the committed turn before
      // its turn_finished event reaches this frame. Never render it twice.
      this.state.liveTurn = view.liveTurn?.id === this.state.liveTipTurnId ? undefined : view.liveTurn;
      this.state.activity = view.activity;
      this.state.modelRetryError = view.modelRetryError;
      this.state.turnStartedAt = view.turnStartedAt;
      this.state.turnFinishedAt = view.turnFinishedAt;
      // Runtime notices are handed off at turn_finished. Recopying them here
      // would overwrite newer local command feedback on every streaming frame.
    } else {
      this.state.liveTurn = undefined;
      this.state.activity = this.runtimeBusy || this.active ? "preparing" : undefined;
    }
  }

  private syncTranscript(): boolean {
    // Opening a picker changes UI state, not the persisted conversation.
    if (!this.historyDirty && this.state.sessionId === this.app.selectedSessionId) return false;
    const switched = this.state.sessionId !== this.app.selectedSessionId;
    const { session, liveTipTurnId, turns, entries, tasks } = this.app.runtime.readSession(this.app.selectedSessionId);
    const transcript = projectTranscript(entries, tasks);
    const last = turns.at(-1);
    if (last?.status === "interrupted") {
      transcript.push({ id: `${last.id}:interrupted`, kind: "interrupted", content: "interrupted" });
    }
    this.state.transcript = transcript;
    this.state.sessionId = session.id;
    this.state.liveTipTurnId = liveTipTurnId;
    this.state.goal = this.app.runtime.readGoal(session.id);
    if (switched) {
      this.viewGeneration++;
      this.viewHistory.length = 0;
      this.state.screen = { type: "session" };
      this.state.notice = undefined;
      this.state.turnStartedAt = undefined;
      this.state.turnFinishedAt = undefined;
      this.state.modelRetryError = undefined;
      this.showQuestion();
    }
    this.historyDirty = false;
    return true;
  }

  private refreshGit(): void {
    const generation = ++this.gitGeneration;
    void gitBranchName(this.app.runtime.rootPath).then((branch) => {
      if (this.stopped || this.disposed || generation !== this.gitGeneration) return;
      if (this.meta.gitBranch === branch) return;
      this.meta.gitBranch = branch;
      this.notify("live");
    });
  }

  private refreshMeta(): void {
    const { messages, usage } = this.app.runtime.contextSnapshot(this.app.selectedSessionId);
    const scan = scanCacheUsage(messages);
    this.refreshModelMeta();
    this.meta.contextPercent = usage ? Math.min(999, Math.round(usage.requestTokens / usage.contextWindow * 100)) : 0;
    this.meta.cacheHitPercent = cacheHitPercent(scan.hitTotals);
    this.meta.cacheMissedTokens = scan.missedTokens;
    this.meta.cacheMissReason = latestCacheMissReason(messages, scan);
  }

  private refreshModelMeta(): void {
    const settings = this.app.runtime.getModelSettings(this.app.selectedSessionId);
    const displayed = settings.active ?? settings;
    this.meta.modelName = displayed.model?.modelId ?? "no model";
    this.meta.thinkingLevel = displayed.thinkingLevel;
    this.meta.supportsThinking = settings.active ? settings.active.model.reasoning === true : settings.supportsThinking;
    this.meta.acceptsImages = settings.model?.acceptsImages === true;
    const modelChanged = settings.active && (settings.model?.providerId !== settings.active.model.providerId ||
      settings.model?.modelId !== settings.active.model.modelId);
    const configuredName = settings.model
      ? (modelChanged ? `${settings.model.providerId}/${settings.model.modelId}` : settings.model.modelId)
      : "no model";
    this.meta.nextModelSettings = settings.active && (modelChanged || settings.thinkingLevel !== settings.active.thinkingLevel)
      ? `${configuredName} · ${settings.thinkingLevel}` : undefined;
  }

  private notify(kind: UiNotifyKind = "full"): void {
    for (const listener of this.listeners) {
      try { listener(kind); } catch { /* renderer errors do not alter state */ }
    }
  }
}
