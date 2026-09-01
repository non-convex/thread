import type {
  CliRenderer,
  KeyEvent,
  ScrollBoxRenderable,
  TextareaRenderable,
  ThemeMode,
} from "@opentui/core";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { Match, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { moveSelection, type UiScreen } from "../state.js";
import { applyComposerSuggestion, composerSuggestions } from "./completion.js";
import type { ThreadTuiViewModel } from "./controller.js";
import type { ThreadViewResources } from "./resources.js";
import { DocumentScreen } from "./screens.js";
import { estimatedWrappedLines, COMPOSER_MAX_LINES, COMPOSER_MIN_LINES, SessionScreen } from "./session-screen.js";
import { createThreadSyntaxStyle, terminalTheme } from "./theme.js";

export function ThreadRoot(props: {
  controller: ThreadTuiViewModel;
  resources: ThreadViewResources;
}) {
  const dimensions = useTerminalDimensions();
  const [revision, setRevision] = createSignal(0);
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
  let composer: TextareaRenderable | undefined;
  let sessionScroll: ScrollBoxRenderable | undefined;
  let screenScroll: ScrollBoxRenderable | undefined;
  const state = () => {
    revision();
    return props.controller.state;
  };
  const meta = () => {
    revision();
    return props.controller.meta;
  };
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
  const unsubscribe = props.controller.subscribe(() => setRevision((value) => value + 1));
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
    if (active.type === "model_picker" || active.type === "subagent_settings" || active.type === "rewind") {
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

  useKeyboard((key: KeyEvent) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      if (props.controller.interrupt()) return;
      if (composer?.plainText) {
        props.controller.cancelIdleExitGesture();
        composer.clear();
        setComposerText("");
        setComposerCursor(0);
        setForcePathCompletion(false);
        return;
      }
      props.controller.idleCtrlC();
      return;
    }
    props.controller.cancelIdleExitGesture();
    if (key.ctrl && key.name === "d" && screen().type === "session" && !composer?.plainText) {
      key.preventDefault();
      props.controller.requestStop();
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
    if (activeScreen.type === "model_picker" || activeScreen.type === "subagent_settings" || activeScreen.type === "rewind") {
      // The picker/path-action panels float over the session screen: selection
      // keys move the view-side signal (no notify — that is what flickered),
      // enter goes to the controller, everything else reaches the composer.
      const count = activeScreen.type === "model_picker"
        ? activeScreen.models.length
        : activeScreen.type === "subagent_settings"
          ? 2
          : activeScreen.items.length;
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
        <Match when={screen().type === "session" || screen().type === "model_picker" || screen().type === "subagent_settings" || screen().type === "rewind" || screen().type === "ask"}>
          <SessionScreen
            controller={props.controller}
            state={state}
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
  disposeResources: () => void;
}> {
  let mode: ThemeMode | null = renderer.themeMode;
  if (!mode) mode = await renderer.waitForThemeMode(80);
  const theme = terminalTheme(mode);
  const syntaxStyle = createThreadSyntaxStyle(theme);
  const resources: ThreadViewResources = { theme, syntaxStyle };
  await render(() => <ThreadRoot controller={controller} resources={resources} />, renderer);
  return {
    disposeResources: () => syntaxStyle.destroy(),
  };
}
