import type {
  CliRenderer,
  HostClipboardService,
  KeyEvent,
  ScrollBoxRenderable,
  TextareaRenderable,
  ThemeMode,
} from "@opentui/core";
import { render, useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { Match, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  isFloatingOverlay,
  moveSelection,
  overlaySelectionCount,
  type LiveTurn,
  type TranscriptItem,
  type UiScreen,
} from "../state.js";
import type { ComposerImage } from "../images.js";
import { tryCreateHostClipboard } from "./clipboard.js";
import { applyComposerSuggestion, composerSuggestions } from "./completion.js";
import {
  beginClipboardImagePaste,
  handleComposerPaste,
  pasteHostClipboard,
  pasteHostClipboardImage,
  type ComposerPasteHost,
} from "./composer-paste.js";
import type { ThreadTuiViewModel } from "./controller.js";
import type { ThreadViewResources } from "./resources.js";
import { DocumentScreen } from "./screens.js";
import { estimatedWrappedLines, COMPOSER_MAX_LINES, COMPOSER_MIN_LINES, SessionScreen } from "./session-screen.js";
import { createThreadSyntaxStyle, terminalTheme } from "./theme.js";

export function ThreadRoot(props: {
  controller: ThreadTuiViewModel;
  resources: ThreadViewResources;
  hostClipboard?: HostClipboardService;
}) {
  const dimensions = useTerminalDimensions();
  const [fullRevision, setFullRevision] = createSignal(0);
  const [liveRevision, setLiveRevision] = createSignal(0);
  const [composerText, setComposerText] = createSignal("");
  const [composerCursor, setComposerCursor] = createSignal(0);
  const [forcePathCompletion, setForcePathCompletion] = createSignal(false);
  const [suggestionIndex, setSuggestionIndex] = createSignal(0);
  /* Selection for the floating overlays (model picker and path actions). Kept in a
   * local signal instead of the mutable screen object so arrow keys repaint
   * only the overlay rows — routing every keystroke through the controller's
   * notify() re-evaluated every state()/meta() binding in the tree and the
   * whole session visibly flickered. The view writes each move back onto the
   * screen object so the controller's enter path still reads it.
   * `overlayNavigated` marks "the user moved since the last notify" so the
   * overlays can drop stale confirm/error lines immediately. */
  const [overlaySelected, setOverlaySelected] = createSignal(0);
  const [overlayNavigated, setOverlayNavigated] = createSignal(false);
  const [attachments, setAttachments] = createSignal<ComposerImage[]>([]);
  const [pendingPastes, setPendingPastes] = createSignal(0);
  let composer: TextareaRenderable | undefined;
  let lastDirectPasteAt = 0;
  let directClipboardPastes = 0;
  let pasteEpoch = 0;
  let sessionScroll: ScrollBoxRenderable | undefined;
  let screenScroll: ScrollBoxRenderable | undefined;
  const state = () => {
    liveRevision();
    fullRevision();
    return props.controller.state;
  };
  const meta = () => {
    liveRevision();
    fullRevision();
    return props.controller.meta;
  };
  const transcript = createMemo((): readonly TranscriptItem[] => {
    fullRevision();
    return props.controller.state.transcript;
  });
  const liveTurn = createMemo((): LiveTurn | undefined => {
    liveRevision();
    return props.controller.state.liveTurn;
  });
  const screen = () => state().screen;
  const suggestions = createMemo(() => composerSuggestions({
    input: composerText(),
    cursor: composerCursor(),
    rootPath: props.controller.meta.rootPath,
    commands: props.controller.slashSuggestions,
    forcePaths: forcePathCompletion(),
  }));
  const composerHeight = createMemo(() => Math.max(
    COMPOSER_MIN_LINES,
    Math.min(COMPOSER_MAX_LINES, estimatedWrappedLines(composerText(), Math.max(12, dimensions().width - 8))),
  ));
  const unsubscribe = props.controller.subscribe((kind) => {
    if (kind === "live") setLiveRevision((value) => value + 1);
    else {
      setLiveRevision((value) => value + 1);
      setFullRevision((value) => value + 1);
    }
  });
  onCleanup(unsubscribe);

  createEffect(() => {
    const activeState = state();
    if (activeState.screen.type === "session" && composer) {
      if (!activeState.busy) composer.focus();
    }
  });

  /* Re-sync the view-side overlay selection whenever the controller (re)opens
   * or updates one of the floating panels. Between notifies the same values
   * are set, which Solid treats as no-ops. */
  createEffect(() => {
    const active = screen();
    if (isFloatingOverlay(active)) {
      setOverlaySelected(active.selected);
      setOverlayNavigated(false);
    }
  });

  createEffect(() => {
    composerText();
    composerCursor();
    setSuggestionIndex(0);
  });

  const applySuggestion = (submit: boolean): boolean => {
    const suggestion = suggestions()[suggestionIndex()];
    if (!suggestion || !composer) return false;
    if (submit && suggestion.submit) {
      composer.clear();
      setComposerText("");
      setComposerCursor(0);
      setForcePathCompletion(false);
      void props.controller.submit(suggestion.replacement.trim());
    } else {
      const next = applyComposerSuggestion(composerText(), suggestion);
      composer.setText(next.input);
      composer.cursorOffset = next.cursor;
      setComposerText(next.input);
      setComposerCursor(next.cursor);
      setForcePathCompletion(false);
    }
    return true;
  };

  const pasteHost = (): ComposerPasteHost => {
    const epoch = pasteEpoch;
    return {
      rootPath: props.controller.meta.rootPath,
      attachments,
      setAttachments: (images) => {
        if (epoch === pasteEpoch) setAttachments(images);
      },
      insertText: (text) => {
        if (epoch !== pasteEpoch || !composer) return;
        composer.editBuffer.insertText(text);
        setComposerText(composer.plainText);
        setComposerCursor(composer.cursorOffset);
      },
      note: (text, level) => {
        if (epoch === pasteEpoch) props.controller.note(text, level);
      },
      ...(props.hostClipboard ? { hostClipboard: props.hostClipboard } : {}),
    };
  };

  const trackPaste = (operation: Promise<unknown>, directClipboard = false): void => {
    const epoch = pasteEpoch;
    if (directClipboard) directClipboardPastes += 1;
    setPendingPastes((count) => count + 1);
    const settle = () => {
      if (directClipboard) {
        directClipboardPastes = Math.max(0, directClipboardPastes - 1);
        lastDirectPasteAt = Date.now();
      }
      if (epoch === pasteEpoch) setPendingPastes((count) => Math.max(0, count - 1));
    };
    void operation.then(settle, settle);
  };

  const clearDraft = (): void => {
    pasteEpoch += 1;
    setPendingPastes(0);
    composer?.clear();
    setComposerText("");
    setComposerCursor(0);
    setForcePathCompletion(false);
    setAttachments([]);
  };

  const composerOpen = () => screen().type === "session" || isFloatingOverlay(screen());

  usePaste((event) => {
    if (!composerOpen()) return;
    if (directClipboardPastes > 0 || Date.now() - lastDirectPasteAt < 400) {
      event.preventDefault();
      return;
    }
    trackPaste(handleComposerPaste(pasteHost(), event));
  });

  useKeyboard((key: KeyEvent) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (props.controller.interrupt()) return;
      if (composer?.plainText || attachments().length > 0 || pendingPastes() > 0) {
        props.controller.cancelIdleExitGesture();
        clearDraft();
        return;
      }
      props.controller.idleCtrlC();
      return;
    }
    props.controller.cancelIdleExitGesture();
    if (key.ctrl && key.name === "d" && screen().type === "session" && !composer?.plainText && attachments().length === 0 && pendingPastes() === 0) {
      key.preventDefault();
      props.controller.requestStop();
      return;
    }
    if (composerOpen() && key.name === "v" && !key.shift) {
      /* Ctrl+V is the primary image key, but Windows Terminal binds it to its own
       * text paste and never forwards the key: when the clipboard holds only an
       * image the terminal sends nothing at all. Alt+V is not intercepted by any
       * common terminal, so it is the reliable image key there (Claude Code and
       * OpenCode ship the same pair). */
      const ctrlV = key.ctrl && !key.meta && !key.option;
      const altV = !key.ctrl && (key.meta || key.option);
      if (ctrlV || altV) {
        const nativePaste = beginClipboardImagePaste(pasteHost());
        if (nativePaste) {
          key.preventDefault();
          lastDirectPasteAt = Date.now();
          trackPaste(nativePaste, true);
          return;
        }
        if (props.hostClipboard) {
          key.preventDefault();
          lastDirectPasteAt = Date.now();
          trackPaste(
            altV
              ? pasteHostClipboardImage(pasteHost()).then((attached) => {
                  if (!attached) props.controller.note("No image in the clipboard.", "info");
                })
              : pasteHostClipboard(pasteHost()),
            true,
          );
          return;
        }
        if (altV) props.controller.note("No image in the clipboard.", "info");
      }
    }
    if (
      composerOpen() &&
      key.name === "backspace" &&
      !key.ctrl &&
      !key.meta &&
      !composer?.plainText &&
      attachments().length > 0
    ) {
      key.preventDefault();
      setAttachments(attachments().slice(0, -1));
      return;
    }
    if (key.shift && key.name === "tab" && screen().type === "session") {
      key.preventDefault();
      props.controller.cycleThinkingLevel();
      return;
    }
    if (key.name === "escape") {
      /* The ask panel owns escape: a parked question should be dismissable
       * without aborting the whole turn, which is what interrupt() would do. */
      if (screen().type === "ask") {
        key.preventDefault();
        props.controller.handleScreenKey(key);
        return;
      }
      if (props.controller.interrupt()) {
        key.preventDefault();
        return;
      }
      if (screen().type !== "session") {
        key.preventDefault();
        props.controller.closeView();
      } else if (forcePathCompletion()) {
        key.preventDefault();
        setForcePathCompletion(false);
      }
      return;
    }
    const activeScreen = screen();
    /* The ask panel consumes every key: it needs printable characters for a
     * free-text answer, so nothing may fall through to the composer. */
    if (activeScreen.type === "ask") {
      key.preventDefault();
      props.controller.handleScreenKey(key);
      return;
    }
    if (isFloatingOverlay(activeScreen)) {
      // The picker/path-action panels float over the session screen: selection
      // keys move the view-side signal (no notify — that is what flickered),
      // enter goes to the controller, everything else reaches the composer.
      const count = overlaySelectionCount(activeScreen);
      if ((key.name === "up" || key.name === "down") && count > 0 && !activeScreen.busy) {
        key.preventDefault();
        const delta = key.name === "up" ? -1 : 1;
        activeScreen.selected = moveSelection(activeScreen.selected, delta, count);
        activeScreen.error = undefined;
        if (activeScreen.type === "rewind") activeScreen.confirm = false;
        setOverlaySelected(activeScreen.selected);
        setOverlayNavigated(true);
        return;
      }
      if (props.controller.handleScreenKey(key)) {
        key.preventDefault();
        return;
      }
      if (key.name === "pageup" || key.name === "pagedown") {
        key.preventDefault();
        sessionScroll?.scrollBy(key.name === "pageup" ? -0.85 : 0.85, "viewport");
      }
      return;
    }
    if (screen().type === "session") {
      const currentSuggestions = suggestions();
      if (currentSuggestions.length > 0 && (key.name === "up" || key.name === "down")) {
        key.preventDefault();
        const delta = key.name === "up" ? -1 : 1;
        setSuggestionIndex((suggestionIndex() + delta + currentSuggestions.length) % currentSuggestions.length);
        return;
      }
      if (currentSuggestions.length > 0 && key.name === "tab") {
        key.preventDefault();
        applySuggestion(false);
        return;
      }
      if (key.name === "tab") {
        key.preventDefault();
        setForcePathCompletion(true);
        return;
      }
      if (currentSuggestions.length > 0 && ["return", "kpenter", "linefeed"].includes(key.name) && !key.shift) {
        key.preventDefault();
        applySuggestion(currentSuggestions[suggestionIndex()]?.submit ?? false);
        return;
      }
      if (key.name === "pageup" || key.name === "pagedown") {
        key.preventDefault();
        sessionScroll?.scrollBy(key.name === "pageup" ? -0.85 : 0.85, "viewport");
      }
      return;
    }
    const scrollKey = key.name === "up" || key.name === "down" || key.name === "pageup" || key.name === "pagedown";
    const scrollableScreen = screen().type === "document";
    if (scrollableScreen && scrollKey) {
      key.preventDefault();
      if (key.name === "pageup" || key.name === "pagedown") {
        screenScroll?.scrollBy(key.name === "pageup" ? -0.85 : 0.85, "viewport");
      } else {
        screenScroll?.scrollBy(key.name === "up" ? -3 : 3);
      }
      return;
    }
    if (props.controller.handleScreenKey(key)) key.preventDefault();
  });

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={props.resources.theme.background}>
      <Switch>
        {/* The model picker and path-action panels are overlays on
            the session screen, not separate screens, so they all route here. */}
        <Match when={screen().type === "session" || isFloatingOverlay(screen()) || screen().type === "ask"}>
          <SessionScreen
            controller={props.controller}
            state={state}
            transcript={transcript}
            liveTurn={liveTurn}
            meta={meta}
            resources={props.resources}
            composer={() => composer}
            setComposer={(value) => { composer = value; }}
            composerText={composerText}
            setComposerText={setComposerText}
            setComposerCursor={setComposerCursor}
            setForcePathCompletion={setForcePathCompletion}
            suggestions={suggestions}
            suggestionIndex={suggestionIndex}
            overlaySelected={overlaySelected}
            overlayNavigated={overlayNavigated}
            composerHeight={composerHeight}
            terminalWidth={() => dimensions().width}
            attachments={attachments}
            setAttachments={setAttachments}
            pasteBusy={() => pendingPastes() > 0}
            setScroll={(value) => { sessionScroll = value; }}
          />
        </Match>
        <Match when={screen().type === "document"}>
          <DocumentScreen screen={() => screen() as Extract<UiScreen, { type: "document" }>} state={state} resources={props.resources} setScroll={(value) => { screenScroll = value; }} />
        </Match>
      </Switch>
    </box>
  );
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
  try {
    await render(
      () => (
        <ThreadRoot
          controller={controller}
          resources={resources}
          {...(hostClipboard ? { hostClipboard } : {})}
        />
      ),
      renderer,
    );
  } catch (error) {
    await hostClipboard?.dispose().catch(() => undefined);
    syntaxStyle.destroy();
    throw error;
  }
  return {
    disposeResources: async () => {
      await hostClipboard?.dispose().catch(() => undefined);
      syntaxStyle.destroy();
    },
  };
}
