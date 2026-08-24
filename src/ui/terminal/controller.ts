import type { Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ThreadApp } from "../../app.js";
import type { CommandResult, EphemeralView } from "../../commands/types.js";
import { estimateContextTokens } from "../../utils/estimate.js";
import { UiEventBatcher, type UiEvent } from "../events.js";
import {
  createUiState,
  moveModelSelection,
  openEphemeralView,
  reduceUiEvent,
  type TranscriptItem,
  type UiState,
} from "../state.js";
import { projectTranscript } from "./transcript-projection.js";

export interface TerminalMeta {
  rootPath: string;
  /** provider/model — shown where provider disambiguates, e.g. the model picker. */
  modelLabel: string;
  /** Bare model id — shown in the footer and turn labels. */
  modelName: string;
  thinkingLevel: ModelThinkingLevel;
  supportsThinking: boolean;
  contextPercent: number;
  uncommitted: boolean;
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
  readonly slashSuggestions: readonly SlashSuggestion[] = [
    { name: "clear", description: "Clear the visible transcript without changing thread context" },
    { name: "compact", description: "Compact older context and retain recent interactions" },
    { name: "model", description: "Open a list and choose the active model" },
    { name: "thread", description: "Thread version commands: status, history, commit, diff, merge, restore" },
    { name: "rewind", description: "Restore to before a historical turn" },
    { name: "exit", description: "Exit thread" },
  ];

  private readonly listeners = new Set<Listener>();
  private readonly batcher: UiEventBatcher;
  private active: AbortController | undefined;
  private stopped = false;
  private lastCtrlC = 0;
  private idleExitTimer: NodeJS.Timeout | undefined;
  private hiddenThroughEntryId: string | undefined;
  private replayRequested = false;
  private committedIds = new Set<string>();
  private currentTurn: { userEntryId: string | undefined; input: string } | undefined;
  private resolveDone: (() => void) | undefined;
  private readonly donePromise: Promise<void>;

  constructor(private readonly app: ThreadApp) {
    const status = app.versions.status();
    this.state = createUiState(status.currentBranch, status.headCheckpointId, []);
    this.meta = {
      rootPath: app.rootPath,
      modelLabel: app.model ? `${app.model.providerId}/${app.model.modelId}` : "no model",
      modelName: app.model?.modelId ?? "no model",
      thinkingLevel: app.thinkingLevel,
      supportsThinking: app.supportsThinking,
      contextPercent: 0,
      uncommitted: false,
    };
    this.refreshMeta();
    this.donePromise = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
    this.batcher = new UiEventBatcher((event) => this.applyUiEvent(event));
    this.syncTranscript("reset");
  }

  get isActive(): boolean {
    return this.active !== undefined;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitUntilStopped(): Promise<void> {
    return this.donePromise;
  }

  dispose(): void {
    this.batcher.dispose();
    if (this.idleExitTimer) clearTimeout(this.idleExitTimer);
    this.idleExitTimer = undefined;
    this.listeners.clear();
  }

  requestStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.idleExitTimer) clearTimeout(this.idleExitTimer);
    this.idleExitTimer = undefined;
    this.active?.abort(new Error("Terminal session closed"));
    this.resolveStopIfIdle();
  }

  interrupt(): boolean {
    if (!this.active) return false;
    this.active.abort(new Error("Interrupted by user"));
    return true;
  }

  idleCtrlC(): boolean {
    const now = Date.now();
    if (now - this.lastCtrlC < 900) {
      this.requestStop();
      return true;
    }
    this.lastCtrlC = now;
    if (this.idleExitTimer) clearTimeout(this.idleExitTimer);
    this.idleExitTimer = setTimeout(() => {
      this.idleExitTimer = undefined;
      this.lastCtrlC = 0;
      if (this.state.notice?.text === "Press Ctrl+C again to exit") {
        this.state.notice = undefined;
        this.notify();
      }
    }, 900);
    this.state.notice = { level: "info", text: "Press Ctrl+C again to exit" };
    this.notify();
    return false;
  }

  cancelIdleExitGesture(): void {
    if (this.lastCtrlC === 0) return;
    this.lastCtrlC = 0;
    if (this.idleExitTimer) clearTimeout(this.idleExitTimer);
    this.idleExitTimer = undefined;
    if (this.state.notice?.text === "Press Ctrl+C again to exit") {
      this.state.notice = undefined;
      this.notify();
    }
  }

  cycleThinkingLevel(): void {
    if (this.state.screen.type !== "session") return;
    if (this.state.busy) {
      this.state.notice = { level: "info", text: "Wait for the current turn before changing the thinking level" };
    } else {
      const level = this.app.cycleThinkingLevel();
      this.refreshMeta();
      this.state.notice = level === undefined
        ? { level: "info", text: "Current model does not support thinking" }
        : { level: "success", text: `Thinking level: ${level}` };
    }
    this.notify();
  }

  closeView(): void {
    if (this.state.screen.type === "session") return;
    this.state.screen = { type: "session" };
    this.notify();
  }

  handleScreenKey(key: TerminalKey): boolean {
    const screen = this.state.screen;
    const up = key.name === "up" || key.name === "k";
    const down = key.name === "down" || key.name === "j";
    const enter = key.name === "return" || key.name === "kpenter" || key.name === "linefeed";
    if (screen.type === "model_picker") {
      if (!screen.busy && screen.models.length > 0 && (up || down)) {
        moveModelSelection(screen, up ? -1 : 1);
        this.notify();
        return true;
      }
      if (enter) {
        void this.advanceModelPicker();
        return true;
      }
    }
    if (screen.type === "diff") {
      const tabs = ["summary", "context", "workspace"] as const;
      const direct: 0 | 1 | 2 | undefined = key.name === "1" ? 0 : key.name === "2" ? 1 : key.name === "3" ? 2 : undefined;
      if (direct !== undefined) screen.tab = tabs[direct];
      else if (key.name === "tab" || key.name === "right") {
        screen.tab = tabs[(tabs.indexOf(screen.tab) + 1) % tabs.length]!;
      } else if (key.name === "left") {
        screen.tab = tabs[(tabs.indexOf(screen.tab) + tabs.length - 1) % tabs.length]!;
      } else return false;
      this.notify();
      return true;
    }
    if (screen.type === "merge") {
      if (up || down || key.name === "tab") {
        screen.selected = screen.selected === "keep-current" ? "summarize" : "keep-current";
        screen.confirm = false;
        screen.error = undefined;
        this.notify();
        return true;
      }
      if (enter) {
        void this.advanceMerge();
        return true;
      }
    }
    if (screen.type === "history") {
      if (screen.items.length > 0 && (up || down)) {
        const delta = up ? -1 : 1;
        screen.selected = (screen.selected + delta + screen.items.length) % screen.items.length;
        screen.confirm = false;
        screen.error = undefined;
        this.notify();
        return true;
      }
      if (enter) {
        void this.advanceHistory();
        return true;
      }
    }
    return false;
  }

  async submit(raw: string): Promise<void> {
    const input = raw.trim();
    if (!input || this.active || this.state.busy || this.state.screen.type !== "session") return;
    if (input === "/exit") {
      this.requestStop();
      return;
    }
    const active = new AbortController();
    this.active = active;
    this.state.busy = true;
    this.state.activity = input.startsWith("/") ? "running command" : "starting turn";
    this.notify();
    try {
      const result = await this.app.handleInput(input, {
        signal: active.signal,
        onUiEvent: (event) => this.batcher.push(event),
      });
      this.batcher.flush();
      if (result.kind === "command") this.presentCommand(result.result);
      if (result.kind === "turn") {
        if (this.state.liveTurn) {
          this.markStreamedTurnCommitted();
        }
        this.clearLiveTurn();
        this.syncTranscript(this.replayRequested ? "reset" : "append");
        if (result.result.error) this.state.notice = { level: "error", text: result.result.error.message };
      }
      this.replayRequested = false;
      this.refreshMeta();
    } catch (error) {
      this.batcher.flush();
      const message = error instanceof Error ? error.message : String(error);
      this.state.notice = { level: "error", text: message };
      this.state.busy = false;
      this.state.activity = undefined;
      if (this.state.liveTurn) {
        this.markStreamedTurnCommitted();
      }
      this.clearLiveTurn();
      this.syncTranscript(this.replayRequested ? "reset" : "append");
      this.replayRequested = false;
    } finally {
      this.finishActive(active);
      this.state.busy = false;
      this.state.activity = undefined;
      this.notify();
    }
  }

  private applyUiEvent(event: UiEvent): void {
    reduceUiEvent(this.state, event);
    if (event.type === "turn_started") {
      this.currentTurn = { userEntryId: event.userEntryId, input: event.input };
      this.commitUserPrompt(event.userEntryId ?? `user:${event.turnId}`, event.input);
    }
    if (event.type === "head_changed" && event.reason !== "turn") this.replayRequested = true;
    if (event.type === "turn_finished") {
      this.markStreamedTurnCommitted();
      this.clearLiveTurn();
      this.syncTranscript(this.replayRequested ? "reset" : "append");
      this.replayRequested = false;
      this.refreshMeta();
    }
    this.notify();
  }

  private commitUserPrompt(id: string, content: string): void {
    if (this.committedIds.has(id)) return;
    this.committedIds.add(id);
    const item: TranscriptItem = { id, kind: "user", content };
    this.state.transcript = [...this.state.transcript, item];
  }

  private presentCommand(result: CommandResult): void {
    if (result.presentation === "clear") {
      this.hiddenThroughEntryId = this.app.versions.head.sessionHeadId ?? undefined;
      this.state.liveTurn = undefined;
      this.state.transcript = [];
      this.state.notice = undefined;
      this.committedIds.clear();
      return;
    }
    this.syncTranscript(this.replayRequested ? "reset" : "append");
    this.replayRequested = false;
    this.refreshMeta();
    if (result.presentation === "view" && result.view) {
      this.openView(result.view);
      return;
    }
    if (result.content.includes("\n") || result.content.length > 180) {
      this.openView({ type: "document", title: "Thread result", content: result.content });
      return;
    }
    this.state.notice = {
      level: result.changedState ? "success" : "info",
      text: result.content,
    };
  }

  private openView(view: EphemeralView): void {
    openEphemeralView(this.state, view);
    this.notify();
  }

  private async advanceModelPicker(): Promise<void> {
    const screen = this.state.screen;
    if (screen.type !== "model_picker" || screen.busy) return;
    const selected = screen.models[screen.selected];
    if (!selected) return;
    if (selected.providerId === this.app.model?.providerId && selected.modelId === this.app.model.modelId) {
      this.closeView();
      this.state.notice = { level: "info", text: `Already using ${selected.providerId}/${selected.modelId}` };
      this.notify();
      return;
    }

    screen.busy = true;
    screen.error = undefined;
    const active = new AbortController();
    this.active = active;
    this.notify();
    try {
      const result = await this.app.handleInput(
        `/model ${quoteCommandArgument(selected.providerId)} ${quoteCommandArgument(selected.modelId)}`,
        { signal: active.signal, onUiEvent: (event) => this.batcher.push(event) },
      );
      this.batcher.flush();
      if (result.kind !== "command") throw new Error("Model selection did not produce a command result");
      this.refreshMeta();
      this.closeView();
      this.state.notice = {
        level: result.result.changedState ? "success" : "info",
        text: result.result.content,
      };
    } catch (error) {
      this.batcher.flush();
      screen.error = error instanceof Error ? error.message : String(error);
      this.state.busy = false;
      this.state.activity = undefined;
    } finally {
      screen.busy = false;
      this.finishActive(active);
      this.notify();
    }
  }

  private async advanceMerge(): Promise<void> {
    const screen = this.state.screen;
    if (screen.type !== "merge" || screen.busy || !screen.preview.clean) return;
    if (!screen.confirm) {
      if (screen.selected === "summarize" && !screen.note) {
        screen.busy = true;
        screen.error = undefined;
        const active = new AbortController();
        this.active = active;
        this.notify();
        try {
          screen.note = await this.app.merge.prepareContextNote(screen.preview, active.signal);
          screen.confirm = true;
        } catch (error) {
          screen.error = error instanceof Error ? error.message : String(error);
        } finally {
          screen.busy = false;
          this.finishActive(active);
          this.notify();
        }
        return;
      }
      screen.confirm = true;
      this.notify();
      return;
    }
    screen.busy = true;
    screen.error = undefined;
    const active = new AbortController();
    this.active = active;
    this.notify();
    try {
      const result = await this.app.merge.applyPreview(screen.preview, screen.selected, active.signal, screen.note);
      if (!result.clean || !result.checkpoint) throw new Error("Merge could not be applied cleanly");
      this.state.branch = this.app.versions.currentBranch.name;
      this.state.checkpointId = result.checkpoint.id;
      this.replayRequested = true;
      this.refreshMeta();
      this.closeView();
      this.syncTranscript("reset");
      this.state.notice = { level: "success", text: `Merged ${screen.preview.incomingLabel} as ${short(result.checkpoint.id)}` };
    } catch (error) {
      screen.error = error instanceof Error ? error.message : String(error);
      screen.confirm = false;
    } finally {
      screen.busy = false;
      this.finishActive(active);
      this.notify();
    }
  }

  private async advanceHistory(): Promise<void> {
    const screen = this.state.screen;
    if (screen.type !== "history" || screen.busy || screen.items.length === 0) return;
    if (!screen.confirm) {
      screen.confirm = true;
      this.notify();
      return;
    }
    const selected = screen.items[screen.selected]!;
    screen.busy = true;
    screen.error = undefined;
    const active = new AbortController();
    this.active = active;
    this.notify();
    try {
      active.signal.throwIfAborted();
      const checkpoint = await this.app.versions.restoreTurnBefore(selected.turnId);
      active.signal.throwIfAborted();
      this.state.branch = this.app.versions.currentBranch.name;
      this.state.checkpointId = checkpoint.id;
      this.refreshMeta();
      this.closeView();
      this.syncTranscript("reset");
      this.state.notice = { level: "success", text: `Restored to before ${short(selected.turnId)}` };
    } catch (error) {
      screen.error = error instanceof Error ? error.message : String(error);
      screen.confirm = false;
    } finally {
      screen.busy = false;
      this.finishActive(active);
      this.notify();
    }
  }

  private syncTranscript(mode: "append" | "reset"): void {
    const items = this.buildTranscript();
    this.state.transcript = items;
    if (mode === "reset") {
      this.committedIds = new Set(items.map((item) => item.id));
      return;
    }
    const pending = items.filter((item) => !this.committedIds.has(item.id));
    if (pending.length === 0) return;
    for (const item of pending) this.committedIds.add(item.id);
  }

  private clearLiveTurn(): void {
    if (!this.state.liveTurn) return;
    this.state.liveTurn = undefined;
  }

  private markStreamedTurnCommitted(): void {
    const turn = this.currentTurn;
    if (!turn) return;
    const items = this.buildTranscript();
    let start = turn.userEntryId ? items.findIndex((item) => item.id === turn.userEntryId) : -1;
    if (start < 0) {
      for (let index = items.length - 1; index >= 0; index--) {
        const item = items[index];
        if (item?.kind === "user" && item.content === turn.input) {
          start = index;
          break;
        }
      }
    }
    if (start >= 0) {
      for (const item of items.slice(start)) {
        if (["user", "assistant", "thinking", "tool"].includes(item.kind)) this.committedIds.add(item.id);
      }
    }
    this.currentTurn = undefined;
  }

  private buildTranscript(): TranscriptItem[] {
    const head = this.app.versions.head.sessionHeadId;
    const toolRecords = this.app.session.projection.records.filter((record) => record.type === "tool_started");
    return projectTranscript(this.app.session.pathTo(head), toolRecords, this.hiddenThroughEntryId);
  }

  private refreshMeta(): void {
    const head = this.app.versions.head;
    const context = this.app.session.buildContext(head.sessionHeadId);
    const tokens = estimateContextTokens(context.messages as Message[]).tokens;
    const model = this.app.model;
    const window = model?.contextWindow ?? 0;
    this.meta.modelLabel = model ? `${model.providerId}/${model.modelId}` : "no model";
    this.meta.modelName = model?.modelId ?? "no model";
    this.meta.thinkingLevel = this.app.thinkingLevel;
    this.meta.supportsThinking = this.app.supportsThinking;
    this.meta.contextPercent = window > 0 ? Math.min(999, Math.round(tokens / window * 100)) : 0;
    this.meta.uncommitted = ![...this.app.session.projection.commits.values()]
      .some((commit) => commit.checkpointId === head.id);
    this.state.branch = this.app.versions.currentBranch.name;
    this.state.checkpointId = head.id;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Presentation listeners are isolated from durable execution.
      }
    }
  }

  private finishActive(active: AbortController): void {
    if (this.active === active) this.active = undefined;
    this.resolveStopIfIdle();
  }

  private resolveStopIfIdle(): void {
    if (this.stopped && !this.active) this.resolveDone?.();
  }
}

export function short(value: string): string {
  const compact = value.includes("_") ? value.slice(value.indexOf("_") + 1) : value;
  return compact.length > 12 ? compact.slice(0, 12) : compact;
}

function quoteCommandArgument(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
