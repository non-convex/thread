import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ThreadApp } from "../../app.js";
import type { CommandResult, EphemeralView } from "../../commands/types.js";
import { cacheHitPercent, latestCacheMissReason, scanCacheUsage } from "../../context/usage.js";
import { gitBranchName } from "../../utils/git.js";
import { AskDismissedError, type AskAnswers, type AskRequest } from "../ask.js";
import { UiEventBatcher, type UiEvent } from "../events.js";
import { composerImageContent, type ComposerImage } from "../images.js";
import {
  createUiState,
  filteredModels,
  isFloatingOverlay,
  openEphemeralView,
  reduceUiEvent,
  type AskScreen,
  type UiScreen,
  type UiState,
} from "../state.js";
import { projectTranscript } from "./transcript-projection.js";

export interface TerminalMeta {
  rootPath: string;
  modelLabel: string;
  modelName: string;
  thinkingLevel: ModelThinkingLevel;
  supportsThinking: boolean;
  contextPercent: number;
  cacheHitPercent: number | null;
  cacheMissedTokens: number;
  cacheMissReason: "idle" | "model-changed" | "prefix-changed" | null;
  gitBranch: string | undefined;
  acceptsImages: boolean;
}

export interface SlashSuggestion {
  name: string;
  description: string;
}

export function primarySlashSuggestions(hasSkills: boolean): SlashSuggestion[] {
  return [
    { name: "clear", description: "Clear the visible transcript" },
    { name: "compact", description: "Compact the current path's live context" },
    { name: "agent", description: "Configure agent models and background agents" },
    { name: "model", description: "Inspect or select the main model" },
    { name: "new", description: "Create an empty Session from the project Root" },
    { name: "session", description: "List or resume root Sessions" },
    ...(hasSkills ? [{ name: "skill", description: "List or invoke an installed skill" }] : []),
    { name: "thread", description: "Session Tree status, history, Sessions, and search" },
    { name: "rewind", description: "Undo built-in file edits and rewind the conversation" },
    { name: "exit", description: "Exit thread" },
  ];
}

export interface TerminalKey {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  sequence?: string;
}

function printableKey(key: TerminalKey): string | undefined {
  if (key.ctrl || key.meta || !key.sequence || key.sequence.length !== 1) return undefined;
  const code = key.sequence.codePointAt(0)!;
  return code >= 0x20 && code !== 0x7f ? key.sequence : undefined;
}

export type UiNotifyKind = "live" | "full";
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

export interface ThreadTuiViewModel {
  readonly state: UiState;
  readonly meta: TerminalMeta;
  readonly slashSuggestions: readonly SlashSuggestion[];
  subscribe(listener: (kind: UiNotifyKind) => void): () => void;
  interrupt(): boolean;
  idleCtrlC(): boolean;
  cancelIdleExitGesture(): void;
  cycleThinkingLevel(): void;
  closeView(): void;
  handleScreenKey(key: TerminalKey): boolean;
  submit(raw: string, images?: readonly ComposerImage[]): Promise<void>;
  note(text: string, level?: "info" | "success" | "error"): void;
  requestStop(): void;
}

export class ThreadTuiController {
  readonly state: UiState;
  readonly meta: TerminalMeta;
  readonly slashSuggestions: readonly SlashSuggestion[];
  private readonly listeners = new Set<Listener>();
  private readonly viewHistory: UiScreen[] = [];
  private readonly batcher: UiEventBatcher;
  private active: AbortController | undefined;
  private stopped = false;
  private lastCtrlC = 0;
  private idleExitTimer: NodeJS.Timeout | undefined;
  private gitGeneration = 0;
  private pendingAsk: { resolve: (answers: AskAnswers) => void; reject: (error: Error) => void } | undefined;
  private askAnswers: string[][] = [];
  private readonly detachAsk: () => void;
  private resolveDone: (() => void) | undefined;
  private readonly donePromise: Promise<void>;

  constructor(private readonly app: ThreadApp) {
    this.slashSuggestions = primarySlashSuggestions(app.skills.length > 0);
    this.state = createUiState(app.sessionTree.activeSession.id, app.sessionTree.activeLiveTip, []);
    this.meta = {
      rootPath: app.rootPath,
      modelLabel: app.model ? `${app.model.providerId}/${app.model.modelId}` : "no model",
      modelName: app.model?.modelId ?? "no model",
      thinkingLevel: app.thinkingLevel,
      supportsThinking: app.supportsThinking,
      contextPercent: 0,
      cacheHitPercent: null,
      cacheMissedTokens: 0,
      cacheMissReason: null,
      gitBranch: undefined,
      acceptsImages: app.model?.acceptsImages === true,
    };
    this.donePromise = new Promise<void>((resolve) => { this.resolveDone = resolve; });
    this.batcher = new UiEventBatcher((events) => this.applyUiEvents(events));
    this.detachAsk = app.setAskPresenter({ present: (request, signal) => this.presentAsk(request, signal) });
    this.syncTranscript();
    this.refreshMeta();
    this.refreshGit();
    if (app.agentProfileDiagnostics.length) {
      this.state.notice = {
        level: app.agentProfileDiagnostics.some((item) => item.level === "error") ? "error" : "info",
        text: app.agentProfileDiagnostics.map((item) => `${item.profileId}: ${item.message}`).join(" · "),
      };
    }
  }

  get isActive(): boolean { return this.active !== undefined; }
  get isStopped(): boolean { return this.stopped; }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitUntilStopped(): Promise<void> { return this.donePromise; }

  dispose(): void {
    this.batcher.dispose();
    if (this.idleExitTimer) clearTimeout(this.idleExitTimer);
    this.pendingAsk?.reject(new DOMException("Aborted", "AbortError"));
    this.detachAsk();
    this.listeners.clear();
  }

  requestStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.active?.abort(new DOMException("Aborted", "AbortError"));
    this.resolveDone?.();
    this.notify();
  }

  interrupt(): boolean {
    if (!this.active) return false;
    this.active.abort(new DOMException("Aborted", "AbortError"));
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
    const level = this.app.cycleThinkingLevel();
    if (!level) return;
    this.refreshMeta();
    this.state.notice = { level: "info", text: `Thinking: ${level}` };
    this.notify();
  }

  closeView(): void {
    if (this.state.screen.type === "ask") {
      this.pendingAsk?.reject(new AskDismissedError());
    } else {
      this.state.screen = this.viewHistory.pop() ?? { type: "session" };
      this.state.notice = undefined;
    }
    this.notify();
  }

  handleScreenKey(key: TerminalKey): boolean {
    const screen = this.state.screen;
    const enter = ["return", "kpenter", "linefeed"].includes(key.name);
    if (screen.type === "ask") return this.handleAskKey(screen, key, {
      up: key.name === "up",
      down: key.name === "down",
      enter,
    });
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
    if (this.active || this.stopped || (!raw.trim() && images.length === 0)) return;
    this.viewHistory.length = 0;
    await this.executeInput(raw, images);
  }

  private async executeInput(raw: string, images: readonly ComposerImage[] = []): Promise<boolean> {
    const input = raw.trim();
    if ((!input && images.length === 0) || this.active || this.stopped) return false;
    if (input === "/exit") {
      this.requestStop();
      return true;
    }
    const imageBlocks = images.map(composerImageContent);
    if (imageBlocks.length > 0 && this.app.model?.acceptsImages !== true) {
      this.note("Current model does not accept images. Use /model to pick a vision model.", "error");
      return false;
    }
    const active = new AbortController();
    this.active = active;
    this.state.notice = undefined;
    try {
      const result = await this.app.handleInput(input, {
        signal: active.signal,
        onUiEvent: (event) => this.batcher.push(event),
        ...(imageBlocks.length > 0 ? { images: imageBlocks } : {}),
      });
      this.batcher.flush();
      if (result.kind === "command") this.presentCommand(result.result);
      this.syncTranscript();
      this.state.liveTurn = undefined;
      this.refreshMeta();
      return true;
    } catch (error) {
      this.batcher.flush();
      this.syncTranscript();
      this.state.liveTurn = undefined;
      this.state.notice = { level: "error", text: error instanceof Error ? error.message : String(error) };
      return false;
    } finally {
      if (this.active === active) this.active = undefined;
      if (this.state.turnStartedAt !== undefined && this.state.turnFinishedAt === undefined) {
        this.state.turnFinishedAt = Date.now();
      }
      this.state.busy = false;
      this.state.activity = undefined;
      this.refreshGit();
      this.notify();
    }
  }

  private applyUiEvents(events: readonly UiEvent[]): void {
    let kind: UiNotifyKind = "live";
    let applied = false;
    for (const event of events) {
      try {
        reduceUiEvent(this.state, event);
        if (event.type === "context_updated") this.meta.contextPercent = event.percent;
        if (notifyKind(event) === "full") kind = "full";
        applied = true;
      } catch {
        // One malformed presentation event must not discard the rest of its frame.
      }
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
      if (this.state.screen.type === "model_picker" && this.state.screen !== screen) {
        this.state.screen.filter = screen.filter;
        this.state.screen.selected = 0;
        this.notify();
      }
    }
  }

  private presentAsk(request: AskRequest, signal: AbortSignal): Promise<AskAnswers> {
    return new Promise<AskAnswers>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const settle = (outcome: () => void) => {
        signal.removeEventListener("abort", onAbort);
        this.pendingAsk = undefined;
        if (this.state.screen.type === "ask") this.state.screen = { type: "session" };
        this.notify();
        outcome();
      };
      const onAbort = () => settle(() => reject(new DOMException("Aborted", "AbortError")));
      signal.addEventListener("abort", onAbort, { once: true });
      this.pendingAsk = {
        resolve: (answers) => settle(() => resolve(answers)),
        reject: (error) => settle(() => reject(error)),
      };
      this.state.screen = {
        type: "ask",
        request,
        questionIndex: 0,
        chosen: request.questions.map(() => []),
        selected: 0,
        customText: undefined,
      };
      this.notify();
    });
  }

  private handleAskKey(screen: AskScreen, key: TerminalKey, keys: { up: boolean; down: boolean; enter: boolean }): boolean {
    const question = screen.request.questions[screen.questionIndex];
    if (!question) return true;
    const optionCount = question.options.length;
    // Check for printable character first to enter or continue custom text mode
    const typed = printableKey(key);
    if (typed) {
      if (screen.customText === undefined) screen.customText = "";
      screen.customText += typed;
      this.notify();
      return true;
    }
    // Handle special keys in custom text mode
    if (screen.customText !== undefined) {
      if (key.name === "escape") screen.customText = undefined;
      else if (keys.enter) {
        const value = screen.customText.trim();
        if (value) this.commitAskAnswer(screen, [value]);
      } else if (key.name === "backspace") screen.customText = screen.customText.slice(0, -1);
      this.notify();
      return true;
    }
    // Handle keys in option selection mode
    if (key.name === "escape") this.pendingAsk?.reject(new AskDismissedError());
    else if ((keys.up || keys.down) && optionCount > 0) {
      screen.selected = (screen.selected + (keys.up ? -1 : 1) + optionCount) % optionCount;
    } else if (key.name === "space" && question.multiple) {
      const current = screen.chosen[screen.questionIndex] ?? [];
      screen.chosen[screen.questionIndex] = current.includes(screen.selected)
        ? current.filter((index) => index !== screen.selected)
        : [...current, screen.selected];
    } else if (keys.enter) {
      const chosen = screen.chosen[screen.questionIndex] ?? [];
      const picked = question.multiple && chosen.length ? chosen : [screen.selected];
      this.commitAskAnswer(screen, picked.map((index) => question.options[index]!.label));
    }
    this.notify();
    return true;
  }

  private commitAskAnswer(screen: AskScreen, labels: string[]): void {
    this.askAnswers[screen.questionIndex] = labels;
    const next = screen.questionIndex + 1;
    if (next < screen.request.questions.length) {
      screen.questionIndex = next;
      screen.selected = 0;
      screen.customText = undefined;
      return;
    }
    const answers = screen.request.questions.map((_question, index) => this.askAnswers[index] ?? []);
    this.askAnswers = [];
    this.pendingAsk?.resolve(answers);
  }

  private activeMessages(): Message[] {
    return this.app.liveContextMessages();
  }

  private syncTranscript(): void {
    const turns = this.app.sessionTree.livePath();
    const entries = turns.flatMap((turn) => this.app.sessionTree.entriesForTurn(turn.id));
    const tasks = turns.flatMap((turn) => this.app.agentTaskDetailsForTurn(turn.id));
    const transcript = projectTranscript(entries, tasks);
    const last = turns.at(-1);
    if (last?.status === "interrupted") {
      transcript.push({ id: `${last.id}:interrupted`, kind: "interrupted", content: "interrupted" });
    }
    this.state.transcript = transcript;
    this.state.sessionId = this.app.sessionTree.activeSession.id;
    this.state.liveTipTurnId = this.app.sessionTree.activeLiveTip;
  }

  private refreshGit(): void {
    const generation = ++this.gitGeneration;
    void gitBranchName(this.app.rootPath).then((branch) => {
      if (this.stopped || generation !== this.gitGeneration) return;
      if (this.meta.gitBranch === branch) return;
      this.meta.gitBranch = branch;
      this.notify("live");
    });
  }

  private refreshMeta(): void {
    const messages = this.activeMessages();
    const scan = scanCacheUsage(messages);
    this.meta.modelLabel = this.app.model ? `${this.app.model.providerId}/${this.app.model.modelId}` : "no model";
    this.meta.modelName = this.app.model?.modelId ?? "no model";
    this.meta.thinkingLevel = this.app.thinkingLevel;
    this.meta.supportsThinking = this.app.supportsThinking;
    this.meta.acceptsImages = this.app.model?.acceptsImages === true;
    this.meta.contextPercent = this.app.contextOccupancy()?.percent ?? 0;
    this.meta.cacheHitPercent = cacheHitPercent(scan.hitTotals);
    this.meta.cacheMissedTokens = scan.totals.missedTokens;
    this.meta.cacheMissReason = latestCacheMissReason(messages, scan);
  }

  private notify(kind: UiNotifyKind = "full"): void {
    for (const listener of this.listeners) {
      try { listener(kind); } catch { /* renderer errors do not alter state */ }
    }
  }
}

export function short(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}
