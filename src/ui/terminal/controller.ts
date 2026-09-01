import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ThreadApp } from "../../app.js";
import type { CommandResult, EphemeralView } from "../../commands/types.js";
import { cacheHitPercent, latestCacheMissReason, scanCacheUsage } from "../../utils/estimate.js";
import { AskDismissedError, type AskAnswers, type AskRequest } from "../ask.js";
import { UiEventBatcher, type UiEvent } from "../events.js";
import {
  createUiState,
  openEphemeralView,
  reduceUiEvent,
  type AskScreen,
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
}

export interface SlashSuggestion {
  name: string;
  description: string;
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

type Listener = () => void;

export interface ThreadTuiViewModel {
  readonly state: UiState;
  readonly meta: TerminalMeta;
  readonly slashSuggestions: readonly SlashSuggestion[];
  subscribe(listener: Listener): () => void;
  interrupt(): boolean;
  idleCtrlC(): boolean;
  cancelIdleExitGesture(): void;
  cycleThinkingLevel(): void;
  closeView(): void;
  handleScreenKey(key: TerminalKey): boolean;
  submit(raw: string): Promise<void>;
  requestStop(): void;
}

export class ThreadTuiController {
  readonly state: UiState;
  readonly meta: TerminalMeta;
  readonly slashSuggestions: readonly SlashSuggestion[];
  private readonly listeners = new Set<Listener>();
  private readonly batcher: UiEventBatcher;
  private active: AbortController | undefined;
  private stopped = false;
  private lastCtrlC = 0;
  private idleExitTimer: NodeJS.Timeout | undefined;
  private pendingAsk: { resolve: (answers: AskAnswers) => void; reject: (error: Error) => void } | undefined;
  private askAnswers: string[][] = [];
  private readonly detachAsk: () => void;
  private resolveDone: (() => void) | undefined;
  private readonly donePromise: Promise<void>;

  constructor(private readonly app: ThreadApp) {
    this.slashSuggestions = [
      { name: "clear", description: "Clear the visible transcript" },
      { name: "compact", description: "Regenerate the current path's context cache" },
      { name: "model", description: "Choose the active model" },
      { name: "new", description: "Create an empty Session from the project Root" },
      { name: "session", description: "List or resume root Sessions" },
      ...(app.skills.length ? [{ name: "skill", description: "List or invoke an installed skill" }] : []),
      { name: "thread", description: "Session Tree status, history, Sessions, and search" },
      { name: "rewind", description: "Return to before a current-path user message" },
      { name: "exit", description: "Exit thread" },
    ];
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
    };
    this.donePromise = new Promise<void>((resolve) => { this.resolveDone = resolve; });
    this.batcher = new UiEventBatcher((event) => this.applyUiEvent(event));
    this.detachAsk = app.setAskPresenter({ present: (request, signal) => this.presentAsk(request, signal) });
    this.syncTranscript();
    this.refreshMeta();
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

  cycleThinkingLevel(): void {
    const level = this.app.cycleThinkingLevel();
    if (!level) return;
    this.refreshMeta();
    this.state.notice = { level: "info", text: `Thinking: ${level}` };
    this.notify();
  }

  closeView(): void {
    if (this.state.screen.type === "ask") this.pendingAsk?.reject(new AskDismissedError());
    else this.state.screen = { type: "session" };
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
    if (screen.type === "model_picker" && enter && !screen.busy) {
      void this.advanceModelPicker();
      return true;
    }
    if (screen.type === "rewind" && enter && !screen.busy) {
      if (!screen.confirm) {
        screen.confirm = true;
        this.notify();
      } else void this.advanceRewind();
      return true;
    }
    return false;
  }

  async submit(raw: string): Promise<void> {
    const input = raw.trim();
    if (!input || this.active || this.stopped) return;
    if (input === "/exit") {
      this.requestStop();
      return;
    }
    const active = new AbortController();
    this.active = active;
    this.state.notice = undefined;
    try {
      const result = await this.app.handleInput(input, {
        signal: active.signal,
        onUiEvent: (event) => this.batcher.push(event),
      });
      this.batcher.flush();
      if (result.kind === "command") this.presentCommand(result.result);
      this.syncTranscript();
      this.state.liveTurn = undefined;
      this.refreshMeta();
    } catch (error) {
      this.batcher.flush();
      this.syncTranscript();
      this.state.liveTurn = undefined;
      this.state.notice = { level: "error", text: error instanceof Error ? error.message : String(error) };
    } finally {
      if (this.active === active) this.active = undefined;
      this.state.busy = false;
      this.state.activity = undefined;
      this.notify();
    }
  }

  private applyUiEvent(event: UiEvent): void {
    reduceUiEvent(this.state, event);
    this.notify();
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
    openEphemeralView(this.state, view);
  }

  private async advanceModelPicker(): Promise<void> {
    const screen = this.state.screen;
    if (screen.type !== "model_picker") return;
    const model = screen.models[screen.selected];
    if (!model) return;
    screen.busy = true;
    this.notify();
    await this.submit(`/model ${model.providerId}/${model.modelId}`);
    if (this.state.screen.type === "model_picker") this.state.screen = { type: "session" };
    this.notify();
  }

  private async advanceRewind(): Promise<void> {
    const screen = this.state.screen;
    if (screen.type !== "rewind") return;
    const item = screen.items[screen.selected];
    if (!item) return;
    screen.busy = true;
    this.notify();
    await this.submit(`/rewind ${item.turnId}`);
    if (this.state.screen.type === "rewind") this.state.screen = { type: "session" };
    this.notify();
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
    if (screen.customText !== undefined) {
      if (key.name === "escape") screen.customText = undefined;
      else if (keys.enter) {
        const value = screen.customText.trim();
        if (value) this.commitAskAnswer(screen, [value]);
      } else if (key.name === "backspace") screen.customText = screen.customText.slice(0, -1);
      else {
        const typed = printableKey(key);
        if (typed) screen.customText += typed;
      }
      this.notify();
      return true;
    }
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
    } else {
      const typed = printableKey(key);
      if (typed) screen.customText = typed;
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
    return this.app.sessionTree.livePath().flatMap((turn) => this.app.sessionTree.messagesForTurn(turn.id));
  }

  private syncTranscript(): void {
    const entries = this.app.sessionTree.livePath().flatMap((turn) => this.app.sessionTree.entriesForTurn(turn.id));
    this.state.transcript = projectTranscript(entries);
    this.state.sessionId = this.app.sessionTree.activeSession.id;
    this.state.liveTipTurnId = this.app.sessionTree.activeLiveTip;
  }

  private refreshMeta(): void {
    const messages = this.activeMessages();
    const scan = scanCacheUsage(messages);
    this.meta.modelLabel = this.app.model ? `${this.app.model.providerId}/${this.app.model.modelId}` : "no model";
    this.meta.modelName = this.app.model?.modelId ?? "no model";
    this.meta.thinkingLevel = this.app.thinkingLevel;
    this.meta.supportsThinking = this.app.supportsThinking;
    this.meta.contextPercent = this.app.contextOccupancy()?.percent ?? 0;
    this.meta.cacheHitPercent = cacheHitPercent(scan.hitTotals);
    this.meta.cacheMissedTokens = scan.totals.missedTokens;
    this.meta.cacheMissReason = latestCacheMissReason(messages, scan);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* renderer errors do not alter state */ }
    }
  }
}

export function short(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}
