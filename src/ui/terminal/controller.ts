import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ThreadApp } from "../../app/thread-app.js";
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
    { name: "agent", description: "Configure agent models and background agents" },
    { name: "model", description: "Inspect or select the main model" },
    { name: "new", description: "Create an empty Session from the project Root" },
    { name: "session", description: "List or resume root Sessions" },
    ...(hasSkills ? [{ name: "skill", description: "List or invoke an installed skill" }] : []),
    { name: "thread", description: "Session Tree status, history, Sessions, and search" },
    { name: "rewind", description: fileCheckpoints ? "Undo built-in file edits and rewind the conversation" : "Rewind the conversation; keep workspace files" },
    { name: "exit", description: "Exit thread" },
  ];
}

type Listener = (kind: UiNotifyKind) => void;

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
  private active: AbortController | undefined;
  private historyDirty = true;
  private stopped = false;
  private lastCtrlC = 0;
  private idleExitTimer: NodeJS.Timeout | undefined;
  private gitGeneration = 0;
  private readonly ask = new AskService();
  private readonly detachAsk: () => void;
  private readonly detachRuntime: () => void;
  private disposed = false;
  private resolveDone: (() => void) | undefined;
  private readonly donePromise: Promise<void>;

  constructor(private readonly app: ThreadApp) {
    this.slashSuggestions = primarySlashSuggestions(app.runtime.skills.length > 0, app.runtime.fileCheckpoints);
    const session = app.runtime.readSession(app.selectedSessionId);
    this.state = createUiState(session.session.id, session.liveTipTurnId, []);
    this.meta = {
      rootPath: app.runtime.rootPath,
      modelName: app.runtime.model?.modelId ?? "no model",
      thinkingLevel: app.runtime.thinkingLevel,
      supportsThinking: app.runtime.supportsThinking,
      contextPercent: 0,
      cacheHitPercent: null,
      cacheMissedTokens: 0,
      cacheMissReason: null,
      gitBranch: undefined,
      acceptsImages: app.runtime.model?.acceptsImages === true,
    };
    this.donePromise = new Promise<void>((resolve) => { this.resolveDone = resolve; });
    this.batcher = new UiEventBatcher((events) => this.applyUiEvents(events));
    this.detachRuntime = app.runtime.subscribe((event) => this.receiveRuntimeEvent(event));
    this.ask.subscribe((request) => {
      if (this.stopped || this.disposed) return;
      if (request) {
        this.state.screen = { type: "ask", request, questionIndex: 0,
          chosen: request.questions.map(() => []), answers: [], selected: 0, customText: undefined };
      } else if (this.state.screen.type === "ask") this.state.screen = { type: "session" };
      this.notify();
    });
    this.detachAsk = app.runtime.setAskPresenter({ present: (request, signal) => {
      if (this.stopped || this.disposed) return Promise.reject(new DOMException("Aborted", "AbortError"));
      return this.ask.present(request, signal);
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
  }

  get isStopped(): boolean { return this.stopped; }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitUntilStopped(): Promise<void> { return this.donePromise; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active?.abort(new DOMException("Aborted", "AbortError"));
    this.detachRuntime();
    this.batcher.dispose();
    if (this.idleExitTimer) clearTimeout(this.idleExitTimer);
    this.ask.dispose();
    this.detachAsk();
    this.listeners.clear();
  }

  requestStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelIdleExitGesture();
    this.detachRuntime();
    this.active?.abort(new DOMException("Aborted", "AbortError"));
    this.resolveDone?.();
    this.notify();
  }

  interrupt(): boolean {
    if (this.stopped || this.disposed) return false;
    if (this.active) {
      this.active.abort(new DOMException("Aborted", "AbortError"));
      return true;
    }
    if (!this.state.busy) return false;
    void this.app.runtime.interrupt(this.app.selectedSessionId).catch(() => undefined);
    return true;
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
      level = this.app.runtime.cycleThinkingLevel();
    } catch {
      return;
    }
    if (!level) return;
    this.meta.thinkingLevel = level;
    this.state.notice = { level: "info", text: `Thinking: ${level}` };
    this.notify();
  }

  closeView(): void {
    if (this.state.screen.type === "ask") {
      this.ask.dismiss(this.state.screen.request.id);
    } else {
      this.state.screen = this.viewHistory.pop() ?? { type: "session" };
      this.state.notice = undefined;
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
    if (screen.busy || this.active) return true;
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

  async submit(raw: string, images: readonly ComposerImage[] = []): Promise<void> {
    if (this.active || this.stopped || this.disposed || (!raw.trim() && images.length === 0)) return;
    this.viewHistory.length = 0;
    await this.executeInput(raw, images);
  }

  private async executeInput(raw: string, images: readonly ComposerImage[] = []): Promise<boolean> {
    const input = raw.trim();
    if ((!input && images.length === 0) || this.active || this.stopped || this.disposed) return false;
    if (input === "/exit") {
      this.requestStop();
      return true;
    }
    const imageBlocks = images.map(composerImageContent);
    if (imageBlocks.length > 0 && this.app.runtime.model?.acceptsImages !== true) {
      this.note("Current model does not accept images. Use /model to pick a vision model.", "error");
      return false;
    }
    const active = new AbortController();
    this.active = active;
    this.state.notice = undefined;
    try {
      const result = await this.app.handleInput(input, {
        signal: active.signal,
        onCommandEvent: (event) => {
          if (!this.stopped && !this.disposed && (event.type === "command_started" || event.type === "command_finished")) {
            this.batcher.push(event);
          }
        },
        ...(imageBlocks.length > 0 ? { images: imageBlocks } : {}),
      });
      if (this.stopped || this.disposed) return true;
      this.batcher.flush();
      if (result.kind === "turn") this.historyDirty = true;
      const historyChanged = this.syncTranscript();
      if (historyChanged) this.state.liveTurn = undefined;
      if (historyChanged || (result.kind === "command" && result.result.changedState)) this.refreshMeta();
      if (result.kind === "command") this.presentCommand(result.result);
      return true;
    } catch (error) {
      if (this.stopped || this.disposed) return false;
      this.batcher.flush();
      // A failed turn may have persisted messages without reaching turn_finished.
      this.historyDirty ||= this.state.liveTurn !== undefined;
      this.syncTranscript();
      this.state.liveTurn = undefined;
      this.state.notice = { level: "error", text: error instanceof Error ? error.message : String(error) };
      return false;
    } finally {
      if (this.active === active) this.active = undefined;
      if (!this.stopped && !this.disposed) {
        if (this.state.turnStartedAt !== undefined && this.state.turnFinishedAt === undefined) {
          this.state.turnFinishedAt = Date.now();
        }
        this.state.busy = false;
        this.state.activity = undefined;
        this.refreshGit();
        this.notify();
      }
    }
  }

  private receiveRuntimeEvent(event: RuntimeEvent): void {
    if (this.stopped || this.disposed || event.sessionId !== this.app.selectedSessionId) return;
    if (event.type === "model_call_started" || event.type === "model_call_finished" ||
        event.type === "model_attempt_started" || event.type === "model_attempt_finished" ||
        (event.type === "agent_run_started" && !event.taskId) || event.type === "agent_run_finished") return;
    if (event.taskId && event.type !== "agent_task_created" && event.type !== "agent_task_updated" && event.type !== "context_updated") {
      this.batcher.push({ type: "agent_task_trace", taskId: event.taskId, revision: event.revision ?? 0, event });
      return;
    }
    this.batcher.push(event.type === "context_updated"
      ? { type: "context_updated", percent: Math.min(999, Math.round(event.estimatedTokens / event.contextWindow * 100)) }
      : event);
  }

  private applyUiEvents(events: readonly UiEvent[]): void {
    if (this.stopped || this.disposed) return;
    let kind: UiNotifyKind = "live";
    let applied = false;
    let settled = false;
    for (const event of events) {
      try {
        reduceUiEvent(this.state, event);
        if (event.type === "context_updated") this.meta.contextPercent = event.percent;
        if (notifyKind(event) === "full") kind = "full";
        if (event.type === "turn_finished" || (event.type === "session_changed" && event.reason !== "turn")) {
          this.historyDirty = true;
          settled = true;
        } else if (event.type === "compaction_finished" && event.reason === "manual" && event.ok && event.entryId) {
          this.historyDirty = true;
        } else if (event.type === "turn_preparing" || event.type === "turn_started") settled = false;
        applied = true;
      } catch {
        // One malformed presentation event must not discard the rest of its frame.
      }
    }
    // Owned input flushes once on completion; external runtime turns refresh here.
    if (!this.active && this.syncTranscript()) {
      if (settled) {
        this.state.liveTurn = undefined;
        this.state.busy = false;
        this.state.activity = undefined;
      }
      this.refreshMeta();
      kind = "full";
    }
    if (applied) this.notify(kind);
  }

  private presentCommand(result: CommandResult): void {
    if (result.presentation === "clear") {
      this.state.transcript = [];
      this.state.liveTurn = undefined;
      return;
    }
    if (result.view) this.openView(result.view);
    else if (result.content) this.state.notice = { level: "success", text: result.content };
  }

  private openView(view: EphemeralView): void {
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
    if (!isFloatingOverlay(screen) || screen.busy || this.active || this.stopped) return;
    screen.busy = true;
    screen.error = undefined;
    this.notify();
    const succeeded = await this.executeInput(command);
    if (this.stopped || this.disposed) return;
    screen.busy = false;
    if (!succeeded) {
      screen.error = this.state.notice?.text ?? "Command failed";
      if (screen.type === "rewind") screen.confirm = false;
    } else if (this.state.screen === screen || this.state.screen.type === "session") {
      this.state.screen = { type: "session" };
      this.viewHistory.length = 0;
    } else if (!replace) {
      this.viewHistory.push(screen);
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
      if (this.stopped || this.disposed) return;
      if (this.state.screen.type === "model_picker" && this.state.screen !== screen) {
        this.state.screen.filter = screen.filter;
        this.state.screen.selected = 0;
        this.notify();
      }
    }
  }

  private syncTranscript(): boolean {
    // Opening a picker changes UI state, not the persisted conversation.
    if (!this.historyDirty && this.state.sessionId === this.app.selectedSessionId) return false;
    const { session, liveTipTurnId, turns, entries, tasks } = this.app.runtime.readSession(this.app.selectedSessionId);
    const transcript = projectTranscript(entries, tasks);
    const last = turns.at(-1);
    if (last?.status === "interrupted") {
      transcript.push({ id: `${last.id}:interrupted`, kind: "interrupted", content: "interrupted" });
    }
    this.state.transcript = transcript;
    this.state.sessionId = session.id;
    this.state.liveTipTurnId = liveTipTurnId;
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
    this.meta.modelName = this.app.runtime.model?.modelId ?? "no model";
    this.meta.thinkingLevel = this.app.runtime.thinkingLevel;
    this.meta.supportsThinking = this.app.runtime.supportsThinking;
    this.meta.acceptsImages = this.app.runtime.model?.acceptsImages === true;
    this.meta.contextPercent = usage ? Math.min(999, Math.round(usage.requestTokens / usage.contextWindow * 100)) : 0;
    this.meta.cacheHitPercent = cacheHitPercent(scan.hitTotals);
    this.meta.cacheMissedTokens = scan.missedTokens;
    this.meta.cacheMissReason = latestCacheMissReason(messages, scan);
  }

  private notify(kind: UiNotifyKind = "full"): void {
    for (const listener of this.listeners) {
      try { listener(kind); } catch { /* renderer errors do not alter state */ }
    }
  }
}
