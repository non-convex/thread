import { type Message } from "@earendil-works/pi-ai";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  isViewportTUI,
  matchesKey,
  type EditorTheme,
  type SlashCommand,
  type TUI,
} from "@earendil-works/pi-tui";
import type { ThreadApp } from "../../app.js";
import type { CommandResult, EphemeralView } from "../../commands/types.js";
import type { SessionEntry } from "../../domain.js";
import { UiEventBatcher } from "../events.js";
import {
  createUiState,
  moveModelSelection,
  openEphemeralView,
  reduceUiEvent,
  type TranscriptItem,
  type UiState,
} from "../state.js";
import { HeaderComponent, FooterComponent, ScreenDocumentComponent, StatusComponent, type TerminalMeta } from "./components.js";
import { cyan, dim, inverse } from "./styles.js";
import { estimateContextTokens } from "../../utils/estimate.js";

export type TerminalMode = "fullscreen" | "regular";

export interface TerminalAppOptions {
  mode: TerminalMode;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const value = block as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") return value.text;
      if (value.type === "thinking" && typeof value.thinking === "string") return value.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function argSummary(args: Record<string, unknown>): string {
  for (const key of ["path", "command", "pattern", "query"]) {
    const value = args[key];
    if (typeof value === "string") return value.replace(/\s+/g, " ").slice(0, 120);
  }
  const encoded = JSON.stringify(args);
  return encoded === "{}" ? "" : encoded.slice(0, 120);
}

function toolResultSummary(name: string, args: Record<string, unknown>, content: string): string {
  const target = argSummary(args);
  if (name === "read" && target) return target;
  const first = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first.slice(0, 180) || target || "completed";
}

function editorTheme(): EditorTheme {
  return {
    borderColor: (text) => dim(text),
    selectList: {
      selectedPrefix: cyan,
      selectedText: inverse,
      description: dim,
      scrollInfo: dim,
      noMatch: dim,
    },
  };
}

export class ThreadTerminalApp {
  private readonly terminal = new ProcessTerminal();
  private readonly tui: TUI;
  private readonly document = new ScreenDocumentComponent(() => this.state);
  private readonly documentContainer = new Container();
  private readonly editorContainer = new Container();
  private readonly editor: Editor;
  private readonly scrollView: ScrollView;
  private readonly state: UiState;
  private readonly meta: TerminalMeta;
  private readonly batcher: UiEventBatcher;
  private active: AbortController | undefined;
  private stopped = false;
  private resolveRun: (() => void) | undefined;
  private lastCtrlC = 0;
  private removeInputListener: (() => void) | undefined;
  private readonly signalHandlers = new Map<NodeJS.Signals, () => void>();
  private hiddenThroughEntryId: string | undefined;

  constructor(
    private readonly app: ThreadApp,
    options: TerminalAppOptions,
  ) {
    const status = app.versions.status();
    const transcript = this.buildTranscript();
    this.state = createUiState(status.currentBranch, status.headCheckpointId, transcript);
    this.meta = {
      rootPath: app.rootPath,
      modelLabel: app.model ? `${app.model.providerId}/${app.model.modelId}` : "no model",
      contextPercent: 0,
      uncommitted: false,
    };
    this.refreshMeta();
    this.tui = options.mode === "fullscreen"
      ? new TuiAltScreen(this.terminal, true, undefined, { mouse: true })
      : new TuiMainScreen(this.terminal, true);
    this.editor = new Editor(this.tui, editorTheme(), { paddingX: 1, autocompleteMaxVisible: 8 });
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(this.slashCommands(), app.rootPath));
    this.editor.onSubmit = (text) => void this.submit(text);
    this.documentContainer.addChild(this.document);
    this.editorContainer.addChild(this.editor);
    this.scrollView = new ScrollView(this.documentContainer, {
      follow: "end",
      primary: true,
      overscroll: "chain",
      scrollbar: "auto",
      scrollbarStyle: dim,
    });
    const header = new HeaderComponent(() => this.state, () => this.meta);
    const statusComponent = new StatusComponent(() => this.state);
    const footer = new FooterComponent(() => this.state, () => this.meta);
    if (isViewportTUI(this.tui)) {
      this.tui.setLayoutRoot(new VStack([
        { component: header, basis: "auto", shrink: 0, minSize: 2 },
        { component: this.scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: statusComponent, basis: "auto", shrink: 1, minSize: 0 },
        { component: this.editorContainer, basis: "auto", shrink: 1, minSize: 0 },
        { component: footer, basis: "auto", shrink: 0, minSize: 1 },
      ]));
    } else {
      this.tui.addChild(header);
      this.tui.addChild(this.documentContainer);
      this.tui.addChild(statusComponent);
      this.tui.addChild(this.editorContainer);
      this.tui.addChild(footer);
    }
    this.batcher = new UiEventBatcher((event) => {
      reduceUiEvent(this.state, event);
      if (event.type === "turn_finished") {
        this.state.transcript = this.buildTranscript();
        this.state.liveTurn = undefined;
        this.refreshMeta();
      }
      this.editor.disableSubmit = this.state.busy;
      this.editor.borderColor = this.state.busy ? cyan : dim;
      this.tui.requestRender();
    });
  }

  async run(): Promise<void> {
    const done = new Promise<void>((resolve) => {
      this.resolveRun = resolve;
    });
    this.removeInputListener = this.tui.addInputListener((data) => this.handleGlobalInput(data));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = () => this.requestStop();
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    try {
      this.tui.setFocus(this.editor);
      this.tui.start();
      await done;
    } finally {
      this.batcher.dispose();
      this.removeInputListener?.();
      for (const [signal, handler] of this.signalHandlers) process.off(signal, handler);
      this.signalHandlers.clear();
      this.tui.stop({ preserveScreen: true });
    }
  }

  private requestStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.active?.abort(new Error("Terminal session closed"));
    this.resolveRun?.();
  }

  private async submit(raw: string): Promise<void> {
    const input = raw.trim();
    if (!input || this.state.busy || this.state.screen.type !== "session") return;
    if (input === "/exit") {
      this.requestStop();
      return;
    }
    this.active = new AbortController();
    this.editor.disableSubmit = true;
    try {
      const result = await this.app.handleInput(input, {
        signal: this.active.signal,
        onUiEvent: (event) => this.batcher.push(event),
      });
      this.batcher.flush();
      if (result.kind === "command") this.presentCommand(result.result);
      if (result.kind === "turn") {
        this.state.transcript = this.buildTranscript();
        this.state.liveTurn = undefined;
        if (result.result.error) this.state.notice = { level: "error", text: result.result.error.message };
      }
      this.refreshMeta();
    } catch (error) {
      this.batcher.flush();
      const message = error instanceof Error ? error.message : String(error);
      this.state.notice = { level: "error", text: message };
      this.state.busy = false;
      this.state.activity = undefined;
    } finally {
      this.active = undefined;
      this.editor.disableSubmit = false;
      this.editor.borderColor = dim;
      this.tui.requestRender();
    }
  }

  private presentCommand(result: CommandResult): void {
    if (result.presentation === "clear") {
      this.hiddenThroughEntryId = this.app.versions.head.sessionHeadId ?? undefined;
      this.state.transcript = [];
      this.state.liveTurn = undefined;
      this.state.notice = undefined;
      this.scrollView.scrollToEnd();
      return;
    }
    this.state.transcript = this.buildTranscript();
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
    this.editorContainer.clear();
    this.tui.setFocus(null);
    this.scrollView.scrollToStart();
    this.tui.requestRender(true);
  }

  private closeView(): void {
    if (this.state.screen.type === "session") return;
    this.state.screen = { type: "session" };
    this.editorContainer.clear();
    this.editorContainer.addChild(this.editor);
    this.editor.disableSubmit = this.state.busy;
    this.tui.setFocus(this.editor);
    this.scrollView.scrollToEnd();
    this.tui.requestRender(true);
  }

  private handleGlobalInput(data: string): { consume?: boolean; data?: string } | undefined {
    if (matchesKey(data, "ctrl+c")) {
      if (this.active) {
        this.active.abort(new Error("Interrupted by user"));
        return { consume: true };
      }
      if (this.editor.getText()) {
        this.editor.setText("");
        return { consume: true };
      }
      const now = Date.now();
      if (now - this.lastCtrlC < 900) this.requestStop();
      else {
        this.lastCtrlC = now;
        this.state.notice = { level: "info", text: "Press Ctrl+C again to exit" };
        this.tui.requestRender();
      }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && this.state.screen.type === "session" && !this.editor.getText()) {
      this.requestStop();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      if (this.active) {
        this.active.abort(new Error("Interrupted by user"));
        return { consume: true };
      }
      if (this.state.screen.type !== "session") {
        this.closeView();
        return { consume: true };
      }
      return undefined;
    }
    const screen = this.state.screen;
    if (screen.type === "model_picker") {
      if (!screen.busy && screen.models.length > 0 &&
        (matchesKey(data, "up") || data === "k" || matchesKey(data, "down") || data === "j")) {
        moveModelSelection(screen, matchesKey(data, "up") || data === "k" ? -1 : 1);
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "enter")) {
        void this.advanceModelPicker();
        return { consume: true };
      }
    }
    if (screen.type === "diff") {
      if (matchesKey(data, "up") || data === "k" || matchesKey(data, "down") || data === "j") {
        this.scrollView.scrollBy(matchesKey(data, "up") || data === "k" ? -1 : 1);
        this.tui.requestRender();
        return { consume: true };
      }
      const tabs = ["summary", "context", "workspace"] as const;
      const direct: 0 | 1 | 2 | undefined = data === "1" ? 0 : data === "2" ? 1 : data === "3" ? 2 : undefined;
      if (direct !== undefined) screen.tab = tabs[direct];
      else if (matchesKey(data, "tab") || matchesKey(data, "right")) {
        screen.tab = tabs[(tabs.indexOf(screen.tab) + 1) % tabs.length]!;
      } else if (matchesKey(data, "left")) {
        screen.tab = tabs[(tabs.indexOf(screen.tab) + tabs.length - 1) % tabs.length]!;
      } else return undefined;
      this.scrollView.scrollToStart();
      this.tui.requestRender();
      return { consume: true };
    }
    if (screen.type === "document" && (matchesKey(data, "up") || data === "k" || matchesKey(data, "down") || data === "j")) {
      this.scrollView.scrollBy(matchesKey(data, "up") || data === "k" ? -1 : 1);
      this.tui.requestRender();
      return { consume: true };
    }
    if (screen.type === "merge") {
      if (matchesKey(data, "up") || data === "k" || matchesKey(data, "down") || data === "j" || matchesKey(data, "tab")) {
        screen.selected = screen.selected === "keep-current" ? "summarize" : "keep-current";
        screen.confirm = false;
        screen.error = undefined;
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "enter")) {
        void this.advanceMerge();
        return { consume: true };
      }
    }
    if (screen.type === "history") {
      if (screen.items.length > 0 && (matchesKey(data, "up") || data === "k" || matchesKey(data, "down") || data === "j")) {
        const delta = matchesKey(data, "up") || data === "k" ? -1 : 1;
        screen.selected = (screen.selected + delta + screen.items.length) % screen.items.length;
        screen.confirm = false;
        screen.error = undefined;
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "enter")) {
        void this.advanceHistory();
        return { consume: true };
      }
    }
    return undefined;
  }

  private async advanceModelPicker(): Promise<void> {
    const screen = this.state.screen;
    if (screen.type !== "model_picker" || screen.busy) return;
    const selected = screen.models[screen.selected];
    if (!selected) return;
    if (selected.providerId === this.app.model?.providerId && selected.modelId === this.app.model.modelId) {
      this.closeView();
      this.state.notice = { level: "info", text: `Already using ${selected.providerId}/${selected.modelId}` };
      return;
    }

    screen.busy = true;
    screen.error = undefined;
    this.active = new AbortController();
    this.tui.requestRender();
    try {
      const result = await this.app.handleInput(
        `/model ${quoteCommandArgument(selected.providerId)} ${quoteCommandArgument(selected.modelId)}`,
        {
          signal: this.active.signal,
          onUiEvent: (event) => this.batcher.push(event),
        },
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
      this.active = undefined;
      this.tui.requestRender();
    }
  }

  private async advanceMerge(): Promise<void> {
    const screen = this.state.screen;
    if (screen.type !== "merge" || screen.busy || !screen.preview.clean) return;
    if (!screen.confirm) {
      if (screen.selected === "summarize" && !screen.note) {
        screen.busy = true;
        screen.error = undefined;
        this.active = new AbortController();
        this.tui.requestRender();
        try {
          screen.note = await this.app.merge.prepareContextNote(screen.preview, this.active.signal);
          screen.confirm = true;
        } catch (error) {
          screen.error = error instanceof Error ? error.message : String(error);
        } finally {
          screen.busy = false;
          this.active = undefined;
          this.tui.requestRender();
        }
        return;
      }
      screen.confirm = true;
      this.tui.requestRender();
      return;
    }
    screen.busy = true;
    screen.error = undefined;
    this.active = new AbortController();
    this.tui.requestRender();
    try {
      const result = await this.app.merge.applyPreview(
        screen.preview,
        screen.selected,
        this.active.signal,
        screen.note,
      );
      if (!result.clean || !result.checkpoint) throw new Error("Merge could not be applied cleanly");
      this.state.branch = this.app.versions.currentBranch.name;
      this.state.checkpointId = result.checkpoint.id;
      this.state.transcript = this.buildTranscript();
      this.refreshMeta();
      this.closeView();
      this.state.notice = { level: "success", text: `Merged ${screen.preview.incomingLabel} as ${short(result.checkpoint.id)}` };
    } catch (error) {
      screen.error = error instanceof Error ? error.message : String(error);
      screen.confirm = false;
    } finally {
      screen.busy = false;
      this.active = undefined;
      this.tui.requestRender();
    }
  }

  private async advanceHistory(): Promise<void> {
    const screen = this.state.screen;
    if (screen.type !== "history" || screen.busy || screen.items.length === 0) return;
    if (!screen.confirm) {
      screen.confirm = true;
      this.tui.requestRender();
      return;
    }
    const selected = screen.items[screen.selected]!;
    screen.busy = true;
    screen.error = undefined;
    this.active = new AbortController();
    this.tui.requestRender();
    try {
      this.active.signal.throwIfAborted();
      const checkpoint = await this.app.versions.restoreTurnBefore(selected.turnId);
      this.active.signal.throwIfAborted();
      this.state.branch = this.app.versions.currentBranch.name;
      this.state.checkpointId = checkpoint.id;
      this.state.transcript = this.buildTranscript();
      this.refreshMeta();
      this.closeView();
      this.state.notice = { level: "success", text: `Restored to before ${short(selected.turnId)}` };
    } catch (error) {
      screen.error = error instanceof Error ? error.message : String(error);
      screen.confirm = false;
    } finally {
      screen.busy = false;
      this.active = undefined;
      this.tui.requestRender();
    }
  }

  private buildTranscript(): TranscriptItem[] {
    const head = this.app.versions.head.sessionHeadId;
    let path = this.app.session.pathTo(head);
    if (this.hiddenThroughEntryId) {
      const hiddenIndex = path.findIndex((entry) => entry.id === this.hiddenThroughEntryId);
      if (hiddenIndex >= 0) path = path.slice(hiddenIndex + 1);
    }
    let start = path.length;
    let userMessages = 0;
    for (let index = path.length - 1; index >= 0; index--) {
      const entry = path[index]!;
      if (entry.type === "message" && entry.message.role === "user") userMessages++;
      start = index;
      if (userMessages >= 40) break;
    }
    const toolRecords = new Map(
      this.app.session.projection.records
        .filter((record) => record.type === "tool_started")
        .map((record) => [record.resultEntryId, record] as const),
    );
    const items: TranscriptItem[] = [];
    for (const entry of path.slice(start)) {
      const item = this.transcriptItem(entry, toolRecords);
      if (item) items.push(item);
    }
    return items;
  }

  private transcriptItem(
    entry: SessionEntry,
    toolRecords: Map<string, Extract<(typeof this.app.session.projection.records)[number], { type: "tool_started" }>>,
  ): TranscriptItem | undefined {
    if (entry.type === "compaction") {
      return { id: entry.id, kind: "compaction", content: entry.summary };
    }
    if (entry.type === "context_merge") {
      return { id: entry.id, kind: "context_merge", label: entry.sourceRef, content: entry.content };
    }
    if (entry.type !== "message") return undefined;
    const message = entry.message;
    if (message.role === "user") return { id: entry.id, kind: "user", content: contentText(message.content) };
    if (message.role === "assistant") {
      const text = contentText(message.content);
      return text ? { id: entry.id, kind: "assistant", content: text } : undefined;
    }
    if (message.role === "toolResult") {
      const record = toolRecords.get(entry.id);
      const args = record?.effectiveArgs ?? {};
      const name = message.toolName || record?.toolName || "tool";
      const text = contentText(message.content);
      const target = argSummary(args);
      return {
        id: entry.id,
        kind: "tool",
        label: target ? `${name}  ${target}` : name,
        content: toolResultSummary(name, args, text),
        isError: message.isError,
      };
    }
    return undefined;
  }

  private refreshMeta(): void {
    const head = this.app.versions.head;
    const context = this.app.session.buildContext(head.sessionHeadId);
    const tokens = estimateContextTokens(context.messages as Message[]).tokens;
    const model = this.app.model;
    const window = model?.contextWindow ?? 0;
    this.meta.modelLabel = model ? `${model.providerId}/${model.modelId}` : "no model";
    this.meta.contextPercent = window > 0 ? Math.min(999, Math.round(tokens / window * 100)) : 0;
    this.meta.uncommitted = ![...this.app.session.projection.commits.values()]
      .some((commit) => commit.checkpointId === head.id);
    this.state.branch = this.app.versions.currentBranch.name;
    this.state.checkpointId = head.id;
  }

  private slashCommands(): SlashCommand[] {
    return [
      { name: "new", description: "Start a new session with empty conversation context" },
      { name: "clear", description: "Clear the visible transcript without changing thread context" },
      { name: "compact", description: "Compact older context and retain as many recent interactions as fit" },
      { name: "model", description: "Open a list and choose the active model" },
      { name: "thread", description: "Thread version commands: status, history, commit, diff, merge, restore" },
      { name: "rewind", description: "Restore to before a historical turn" },
      { name: "exit", description: "Exit thread" },
    ];
  }
}

function short(value: string): string {
  const compact = value.includes("_") ? value.slice(value.indexOf("_") + 1) : value;
  return compact.length > 12 ? compact.slice(0, 12) : compact;
}

function quoteCommandArgument(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
