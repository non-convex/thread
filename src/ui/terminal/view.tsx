import {
  createClipboard, createRendererClipboardAdapter,
  type ClipboardService, type CliRenderer, type HostClipboardService, type KeyEvent, type ScrollBoxRenderable, type ThemeMode,
} from "@opentui/core";
import { render, useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { Match, Switch, batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { currentTurnItems, isFloatingOverlay, moveSelection, overlaySelectionCount, type LiveTurn, type TranscriptItem, type UiScreen } from "../state.js";
import { tryCreateHostClipboard, writeClipboardText, type CopyText } from "./clipboard.js";
import { applyComposerSuggestion, composerSuggestions } from "./completion.js";
import { createComposerDraft } from "./composer-state.js";
import { isEnter } from "./ask-input.js";
import type { ThreadTuiViewModel } from "./view-model.js";
import type { ThreadViewResources } from "./resources.js";
import { DocumentScreen } from "./screens.js";
import { estimatedWrappedLines, COMPOSER_MAX_LINES, COMPOSER_MIN_LINES, SessionScreen } from "./session-screen.js";
import { createThreadSyntaxStyle, terminalTheme } from "./theme.js";

export function ThreadRoot(props: {
  controller: ThreadTuiViewModel;
  resources: ThreadViewResources;
  hostClipboard?: HostClipboardService;
  clipboard?: ClipboardService;
}) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const draft = createComposerDraft(props.controller, props.hostClipboard);
  const copyAbort = new AbortController();
  let copying = false;
  onCleanup(() => copyAbort.abort());
  const [fullRevision, setFullRevision] = createSignal(0);
  const [liveRevision, setLiveRevision] = createSignal(0);
  const [suggestionIndex, setSuggestionIndex] = createSignal(0);
  // Local selection signals repaint only the overlay; the controller retains Enter handling.
  const [overlaySelected, setOverlaySelected] = createSignal(0);
  const [overlayNavigated, setOverlayNavigated] = createSignal(false);
  const [openedWorkerTaskId, setOpenedWorkerTaskId] = createSignal<string>();
  let workerScroll: ScrollBoxRenderable | undefined;
  let sessionScroll: ScrollBoxRenderable | undefined;
  let screenScroll: ScrollBoxRenderable | undefined;
  const state = () => { liveRevision(); fullRevision(); return props.controller.state; };
  const meta = () => { liveRevision(); fullRevision(); return props.controller.meta; };
  const transcript = createMemo((): readonly TranscriptItem[] => { fullRevision(); return props.controller.state.transcript; });
  const liveTurn = createMemo((): LiveTurn | undefined => { liveRevision(); return props.controller.state.liveTurn; });
  const screen = () => state().screen;
  const composerOpen = () => screen().type === "session" || isFloatingOverlay(screen());
  const selectedText = () => renderer.getSelection()?.getSelectedText()
    || (composerOpen() ? draft.editor?.getSelectedText() : "") || "";
  const copyText: CopyText = async (text) => {
    if (copying || !text || copyAbort.signal.aborted) return "cancelled";
    copying = true;
    try {
      const result = await writeClipboardText(renderer, props.clipboard, text, copyAbort.signal);
      if (result === "cancelled" || copyAbort.signal.aborted) return "cancelled";
      props.controller.note(result === "written" ? "Copied to clipboard." : "Text sent to terminal clipboard.",
        result === "written" ? "success" : "info");
      return result;
    } catch (error) {
      if (copyAbort.signal.aborted) return "cancelled";
      props.controller.note(`Copy failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      return "failed";
    } finally {
      copying = false;
    }
  };
  const suggestions = createMemo(() => composerSuggestions({
    input: draft.text(), cursor: draft.cursor(), rootPath: props.controller.meta.rootPath,
    commands: props.controller.slashSuggestions, forcePaths: draft.forcePaths(),
  }));
  const workerCards = createMemo(() => currentTurnItems(state()).flatMap((item) => item.agentTask ? [item.agentTask] : []));
  const workerPanelCard = createMemo(() => screen().type === "session" && !suggestions().length
    ? workerCards().find((card) => card.summary.taskId === openedWorkerTaskId()) : undefined);
  const toggleWorker = (taskId: string) => setOpenedWorkerTaskId((previous) => previous === taskId ? undefined : taskId);
  let workerSessionId = state().sessionId;
  createEffect(() => {
    const sessionId = state().sessionId;
    const id = openedWorkerTaskId();
    if (sessionId !== workerSessionId || (id && !workerCards().some((card) => card.summary.taskId === id))) {
      setOpenedWorkerTaskId(undefined);
    }
    workerSessionId = sessionId;
  });
  const composerHeight = createMemo(() => Math.max(COMPOSER_MIN_LINES, Math.min(COMPOSER_MAX_LINES,
    estimatedWrappedLines(draft.text(), Math.max(12, dimensions().width - 8)))));
  onCleanup(props.controller.subscribe((kind) => batch(() => {
    setLiveRevision((value) => value + 1);
    if (kind !== "live") setFullRevision((value) => value + 1);
  })));

  createEffect(() => {
    const active = state();
    if (active.screen.type !== "session" || !draft.editor) return;
    if (active.composerInput !== undefined) {
      draft.replace(active.composerInput);
      delete active.composerInput;
    }
    if (!active.busy) draft.editor.focus();
  });
  createEffect(() => {
    const active = screen();
    if (isFloatingOverlay(active)) { setOverlaySelected(active.selected); setOverlayNavigated(false); }
  });
  createEffect(() => { draft.text(); draft.cursor(); setSuggestionIndex(0); });

  const applySuggestion = (submit: boolean) => {
    const suggestion = suggestions()[suggestionIndex()];
    if (!suggestion || !draft.editor) return;
    if (submit && suggestion.submit) {
      if (!props.controller.submit(suggestion.replacement.trim())) return;
      draft.editor.clear();
      draft.replace("");
    } else {
      const next = applyComposerSuggestion(draft.text(), suggestion);
      draft.replace(next.input, next.cursor);
    }
  };
  usePaste((event) => { if (composerOpen()) draft.paste(event); });
  useKeyboard((key: KeyEvent) => {
    // OpenTUI owns the mouse selection, so the terminal cannot copy it for us.
    if (key.name === "c" && (key.ctrl || key.meta || key.option)) {
      const text = selectedText();
      if (text || !key.ctrl || key.shift) {
        key.preventDefault();
        props.controller.cancelIdleExitGesture();
        if (text) void copyText(text);
        return;
      }
    }
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (props.controller.interrupt()) return;
      if (draft.editor?.plainText || draft.attachments().length || draft.busy()) {
        props.controller.cancelIdleExitGesture();
        draft.clear();
      } else props.controller.idleCtrlC();
      return;
    }
    props.controller.cancelIdleExitGesture();
    if (key.ctrl && key.name === "d" && screen().type === "session" && !draft.editor?.plainText && !draft.attachments().length && !draft.busy()) {
      key.preventDefault();
      props.controller.requestStop();
      return;
    }
    if (composerOpen() && draft.pasteKey(key)) { key.preventDefault(); return; }
    if (composerOpen() && key.name === "backspace" && !key.ctrl && !key.meta && !draft.editor?.plainText && draft.attachments().length) {
      key.preventDefault();
      draft.setAttachments(draft.attachments().slice(0, -1));
      return;
    }
    if (key.shift && key.name === "tab" && screen().type === "session") {
      key.preventDefault();
      props.controller.cycleThinkingLevel();
      return;
    }
    if (key.name === "escape" && selectedText()) {
      key.preventDefault();
      renderer.clearSelection();
      if (composerOpen()) draft.editor?.clearSelection();
      return;
    }
    // Ask owns Escape and printable input: dismissing a question must not abort the turn.
    if (screen().type === "ask") {
      key.preventDefault();
      props.controller.handleScreenKey(key);
      return;
    }
    if (key.name === "escape" && workerPanelCard()) {
      key.preventDefault();
      setOpenedWorkerTaskId(undefined);
      return;
    }
    if (key.name === "escape") {
      if (screen().type === "document") { key.preventDefault(); props.controller.closeView(); }
      else if (props.controller.interrupt()) key.preventDefault();
      else if (screen().type !== "session") { key.preventDefault(); props.controller.closeView(); }
      else if (draft.forcePaths()) { key.preventDefault(); draft.setForcePaths(false); }
      return;
    }
    const active = screen();
    const direction = key.name === "up" ? -1 : key.name === "down" ? 1 : 0;
    const page = key.name === "pageup" ? -0.85 : key.name === "pagedown" ? 0.85 : 0;
    if (workerPanelCard() && page) {
      key.preventDefault();
      workerScroll?.scrollBy(page, "viewport");
      return;
    }
    if (isFloatingOverlay(active)) {
      const count = overlaySelectionCount(active);
      if (direction && count > 0 && !active.busy) {
        key.preventDefault();
        active.selected = moveSelection(active.selected, direction, count);
        active.error = undefined;
        if (active.type === "rewind") active.confirm = false;
        setOverlaySelected(active.selected);
        setOverlayNavigated(true);
      } else if (props.controller.handleScreenKey(key)) key.preventDefault();
      else if (page) { key.preventDefault(); sessionScroll?.scrollBy(page, "viewport"); }
      return;
    }
    if (active.type === "session") {
      const choices = suggestions();
      if (choices.length && direction) {
        key.preventDefault();
        setSuggestionIndex(moveSelection(suggestionIndex(), direction, choices.length));
      } else if (key.name === "tab") {
        key.preventDefault();
        if (choices.length) applySuggestion(false);
        else draft.setForcePaths(true);
      } else if (choices.length && isEnter(key) && !key.shift) {
        key.preventDefault();
        applySuggestion(choices[suggestionIndex()]?.submit ?? false);
      } else if (page) { key.preventDefault(); sessionScroll?.scrollBy(page, "viewport"); }
      return;
    }
    if (active.type === "document" && (page || direction)) {
      key.preventDefault();
      if (page) screenScroll?.scrollBy(page, "viewport");
      else screenScroll?.scrollBy(direction * 3);
    } else if (props.controller.handleScreenKey(key)) key.preventDefault();
  });

  return <box flexDirection="column" width="100%" height="100%" backgroundColor={props.resources.theme.background}>
    <Switch>
      <Match when={composerOpen() || screen().type === "ask"}>
        <SessionScreen controller={props.controller} state={state} transcript={transcript} liveTurn={liveTurn} meta={meta}
          resources={props.resources} copyText={copyText} draft={draft} suggestions={suggestions} suggestionIndex={suggestionIndex}
          overlaySelected={overlaySelected} overlayNavigated={overlayNavigated} composerHeight={composerHeight}
          terminalWidth={() => dimensions().width} terminalHeight={() => dimensions().height}
          workerCards={workerCards} workerPanelCard={workerPanelCard} onOpenWorker={toggleWorker}
          onCloseWorker={() => setOpenedWorkerTaskId(undefined)}
          setWorkerScroll={(value) => { workerScroll = value; }} setScroll={(value) => { sessionScroll = value; }} />
      </Match>
      <Match when={screen().type === "document"}>
        <DocumentScreen screen={() => screen() as Extract<UiScreen, { type: "document" }>} state={state}
          resources={props.resources} setScroll={(value) => { screenScroll = value; }} />
      </Match>
    </Switch>
  </box>;
}

export async function mountThreadView(renderer: CliRenderer, controller: ThreadTuiViewModel): Promise<{
  disposeResources: () => void | Promise<void>;
}> {
  let mode: ThemeMode | null = renderer.themeMode;
  if (!mode) mode = await renderer.waitForThemeMode(80);
  const theme = terminalTheme(mode);
  const syntaxStyle = createThreadSyntaxStyle(theme);
  const resources: ThreadViewResources = { theme, syntaxStyle };
  const hostClipboard = tryCreateHostClipboard();
  const clipboard = hostClipboard ? createClipboard({ host: hostClipboard, terminal: createRendererClipboardAdapter(renderer) }) : undefined;
  const disposeResources = async () => { await clipboard?.dispose().catch(() => undefined); syntaxStyle.destroy(); };
  try {
    await render(() => <ThreadRoot controller={controller} resources={resources}
      {...(hostClipboard ? { hostClipboard } : {})} {...(clipboard ? { clipboard } : {})} />, renderer);
    return { disposeResources };
  } catch (error) {
    await disposeResources();
    throw error;
  }
}
