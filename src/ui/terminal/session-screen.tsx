import type { KeyBinding, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { createMemo, For, Show, type Accessor } from "solid-js";
import type { LiveTurn, ModelPickerScreen, UiState } from "../state.js";
import type { ComposerSuggestion } from "./completion.js";
import { short, type TerminalMeta, type ThreadTuiViewModel } from "./controller.js";
import type { ThreadViewResources } from "./resources.js";
import { modelDetail, selectedWindow } from "./screens.js";
import { wheelScrollAcceleration } from "./scroll.js";
import { SpinnerText } from "./spinner.js";
import { LiveTurnView, TranscriptTurnsView, WelcomeView } from "./transcript.js";
import { bold } from "./theme.js";

const COMPOSER_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
];

/** Textarea rows: one line minimum, four before the transcript starts scrolling. */
export const COMPOSER_MIN_LINES = 1;
export const COMPOSER_MAX_LINES = 4;

export function estimatedWrappedLines(text: string, width: number, maximum = Number.POSITIVE_INFINITY): number {
  if (!text) return 0;
  const columns = Math.max(1, width);
  let lines = 0;
  for (const line of text.split("\n")) {
    lines += Math.max(1, Math.ceil([...line].length / columns));
    if (lines >= maximum) return maximum;
  }
  return Math.min(lines, maximum);
}

/** Six-cell block meter for the context gauge in the footer. */
export function contextMeter(percent: number, cells = 6): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * cells);
  return "█".repeat(filled) + "░".repeat(cells - filled);
}

/** The meter stays quiet until the context window actually fills up. */
const CONTEXT_WARN_PERCENT = 80;

function Footer(props: {
  state: Accessor<UiState>;
  meta: Accessor<TerminalMeta>;
  resources: ThreadViewResources;
  width: Accessor<number>;
}) {
  const state = props.state;
  const meta = props.meta;
  const theme = () => props.resources.theme;
  const compact = () => props.width() < 72;
  const narrow = () => props.width() < 96;
  const meterColor = () => meta().contextPercent >= CONTEXT_WARN_PERCENT ? theme().warning : theme().muted;
  return (
    <box flexDirection="row" width="100%" height={1} paddingX={1}>
      <text height={1} wrapMode="none" truncate={true} flexShrink={1} fg={theme().softText}>⎇ {state().branch}</text>
      <Show when={!narrow()}>
        <text height={1} wrapMode="none" truncate={true} fg={theme().faint}> · {short(state().checkpointId)}</text>
      </Show>
      <Show when={!narrow() && meta().uncommitted}>
        <text height={1} wrapMode="none" fg={theme().warning}> · dirty</text>
      </Show>
      <Show when={!compact()}>
        <text height={1} wrapMode="none" fg={theme().border}>  │  </text>
        <text height={1} wrapMode="none" fg={meterColor()}>{contextMeter(meta().contextPercent)}</text>
        <text height={1} wrapMode="none" fg={theme().muted}> ctx {meta().contextPercent}%</text>
      </Show>
      <box flexGrow={1} minWidth={1} />
      <text height={1} wrapMode="none" fg={theme().softText} attributes={bold}>{meta().modelName}</text>
      <Show when={meta().supportsThinking}>
        <text height={1} wrapMode="none" fg={theme().muted}> · {meta().thinkingLevel}</text>
        <text height={1} wrapMode="none" fg={theme().faint}> · ⇧⇥ switch thinking level</text>
      </Show>
    </box>
  );
}

function Status(props: { state: Accessor<UiState>; resources: ThreadViewResources }) {
  const state = props.state;
  const theme = () => props.resources.theme;
  const noticeLevel = () => state().notice?.level;
  const color = () => state().busy
    ? theme().accent
    : noticeLevel() === "error"
      ? theme().error
      : noticeLevel() === "success"
        ? theme().success
        : theme().muted;
  return (
    <box flexDirection="row" width="100%" height={1} paddingX={1}>
      <Show when={state().busy}>
        <SpinnerText fg={theme().accent} />
        <text width={1} height={1}> </text>
      </Show>
      <text flexGrow={1} height={1} wrapMode="none" fg={color()} truncate={true}>
        {state().busy
          ? `${state().activity ?? "working"}`
          : state().notice?.text ?? ""}
      </text>
      <Show when={state().busy}>
        <text height={1} wrapMode="none" fg={theme().faint}>esc interrupt</text>
      </Show>
    </box>
  );
}

function ComposerSuggestions(props: {
  suggestions: readonly ComposerSuggestion[];
  selected: number;
  resources: ThreadViewResources;
  /** Interior width of the floating panel (outer minus border and padding). */
  contentWidth: Accessor<number>;
}) {
  return (
    <box flexDirection="column" width={props.contentWidth()} paddingX={1} backgroundColor={props.resources.theme.surface}>
      <For each={props.suggestions}>
        {(suggestion, index) => (
          <box
            flexDirection="row"
            width={props.contentWidth() - 2}
            height={1}
            backgroundColor={index() === props.selected ? props.resources.theme.surfaceHigh : "transparent"}
          >
            <text
              width={14}
              height={1}
              wrapMode="none"
              truncate={true}
              fg={index() === props.selected ? props.resources.theme.accent : props.resources.theme.text}
              attributes={index() === props.selected ? bold : 0}
            >
              {index() === props.selected ? "▸ " : ""}{suggestion.label}
            </text>
            <text
              width={Math.max(4, props.contentWidth() - 16)}
              flexShrink={1}
              height={1}
              wrapMode="none"
              fg={index() === props.selected ? props.resources.theme.softText : props.resources.theme.muted}
              truncate={true}
            >
              {suggestion.description}
            </text>
          </box>
        )}
      </For>
    </box>
  );
}

/* The /model list rides on the session screen exactly like the "/" suggestion
 * popup: a small rounded panel floating above the composer instead of a
 * separate full-screen takeover. */
const MODEL_OVERLAY_MAX_ROWS = 8;

function ModelPickerOverlay(props: {
  screen: Accessor<ModelPickerScreen>;
  resources: ThreadViewResources;
  /** Interior width of the floating panel (outer minus border and padding). */
  contentWidth: Accessor<number>;
}) {
  const theme = () => props.resources.theme;
  const visible = createMemo(() =>
    selectedWindow(props.screen().models, props.screen().selected, MODEL_OVERLAY_MAX_ROWS));
  return (
    // Inside a bordered box, OpenTUI 0.5.7 lets flexGrow/stretch children
    // overshoot the right border by ~2 cells; explicit widths clip exactly.
    <box flexDirection="column" width={props.contentWidth()} paddingX={1}>
      <box flexDirection="row" width={props.contentWidth() - 2} height={1}>
        <text width={Math.max(8, props.contentWidth() - 23)} flexShrink={1} height={1} wrapMode="none" truncate={true} fg={theme().faint}>
          {props.screen().scope === "all"
            ? "all built-in and configured models"
            : "configured models · /model all for the full catalog"}
        </text>
        <text height={1} wrapMode="none" fg={theme().faint}>↑/↓ · ⏎ switch · esc</text>
      </box>
      <For each={visible()}>
        {({ item: model, index }) => {
          const selected = () => index === props.screen().selected;
          const current = () =>
            model.providerId === props.screen().currentProviderId && model.modelId === props.screen().currentModelId;
          return (
            <box
              flexDirection="row"
              width={props.contentWidth() - 2}
              height={1}
              backgroundColor={selected() ? theme().surfaceHigh : "transparent"}
            >
              <text width={2} height={1} wrapMode="none" fg={theme().accent}>
                {selected() ? "▸ " : current() ? "● " : "  "}
              </text>
              <text
                width={30}
                flexShrink={1}
                height={1}
                wrapMode="none"
                truncate={true}
                fg={selected() || current() ? theme().accent : theme().text}
                attributes={selected() ? bold : 0}
              >
                {model.providerId}/{model.modelId}
              </text>
              <text
                width={Math.max(4, props.contentWidth() - 34)}
                flexShrink={1}
                height={1}
                wrapMode="none"
                truncate={true}
                fg={selected() ? theme().softText : theme().muted}
              >
                {modelDetail(model)}
              </text>
            </box>
          );
        }}
      </For>
      <Show when={props.screen().busy}>
        <box flexDirection="row" width={props.contentWidth() - 2} height={1}>
          <SpinnerText fg={theme().accent} />
          <text height={1} wrapMode="none" fg={theme().accent}> switching model…</text>
        </box>
      </Show>
      <Show when={props.screen().error}>
        <text width={props.contentWidth() - 2} height={1} wrapMode="none" truncate={true} fg={theme().error}>{props.screen().error}</text>
      </Show>
    </box>
  );
}

export function SessionScreen(props: {
  controller: ThreadTuiViewModel;
  state: Accessor<UiState>;
  meta: Accessor<TerminalMeta>;
  resources: ThreadViewResources;
  composer: () => TextareaRenderable | undefined;
  setComposer: (value: TextareaRenderable) => void;
  composerText: () => string;
  setComposerText: (value: string) => void;
  setComposerCursor: (value: number) => void;
  setForcePathCompletion: (value: boolean) => void;
  suggestions: () => readonly ComposerSuggestion[];
  suggestionIndex: () => number;
  composerHeight: Accessor<number>;
  terminalWidth: Accessor<number>;
  setScroll: (value: ScrollBoxRenderable) => void;
}) {
  const state = props.state;
  const theme = props.resources.theme;
  // status line + composer (border + textarea row) + footer
  const controlsHeight = () => props.composerHeight() + 4;
  const hasTranscript = () => state().transcript.length > 0 || state().liveTurn !== undefined;
  const modelPicker = (): ModelPickerScreen | undefined =>
    state().screen.type === "model_picker" ? state().screen as ModelPickerScreen : undefined;
  /* Both floating panels sit at left/right 1 with a rounded border, so their
   * interior width is the terminal width minus margins and the two border
   * columns. */
  const overlayContentWidth = () => Math.max(20, props.terminalWidth() - 4);
  const modelOverlayHeight = () => {
    const picker = modelPicker();
    if (!picker) return 0;
    // header + windowed rows + optional busy/error lines + border
    return 1 + Math.min(MODEL_OVERLAY_MAX_ROWS, picker.models.length)
      + (picker.busy ? 1 : 0) + (picker.error ? 1 : 0) + 2;
  };
  return (
    <box position="relative" width="100%" height="100%" backgroundColor={theme.background}>
      <Show
        when={hasTranscript()}
        fallback={
          <box position="absolute" top={0} right={0} bottom={controlsHeight()} left={0}>
            <WelcomeView resources={props.resources} />
          </box>
        }
      >
        <scrollbox
          ref={props.setScroll}
          position="absolute"
          top={0}
          right={0}
          bottom={controlsHeight()}
          left={0}
          stickyScroll={true}
          stickyStart="bottom"
          viewportCulling={true}
          scrollAcceleration={wheelScrollAcceleration}
          verticalScrollbarOptions={{ visible: false }}
          paddingTop={1}
        >
          <TranscriptTurnsView items={state().transcript} resources={props.resources} />
          <Show when={state().liveTurn}>
            {(live: Accessor<LiveTurn>) => (
              <LiveTurnView turn={live} label={`thread · ${props.meta().modelName}`} resources={props.resources} />
            )}
          </Show>
        </scrollbox>
      </Show>
      <Show when={modelPicker() === undefined && props.suggestions().length > 0}>
        <box
          position="absolute"
          right={1}
          bottom={controlsHeight()}
          left={1}
          height={props.suggestions().length + 2}
          zIndex={20}
          border={true}
          borderStyle="rounded"
          borderColor={theme.borderStrong}
          backgroundColor={theme.surface}
        >
          <ComposerSuggestions
            suggestions={props.suggestions()}
            selected={props.suggestionIndex()}
            resources={props.resources}
            contentWidth={overlayContentWidth}
          />
        </box>
      </Show>
      <Show when={modelPicker()}>
        {(picker: Accessor<ModelPickerScreen>) => (
          <box
            position="absolute"
            right={1}
            bottom={controlsHeight()}
            left={1}
            height={modelOverlayHeight()}
            zIndex={20}
            border={true}
            borderStyle="rounded"
            borderColor={theme.borderStrong}
            backgroundColor={theme.surface}
          >
            <ModelPickerOverlay
              screen={picker}
              resources={props.resources}
              contentWidth={overlayContentWidth}
            />
          </box>
        )}
      </Show>
      <box
        position="absolute"
        right={0}
        bottom={0}
        left={0}
        height={controlsHeight()}
        zIndex={30}
        flexDirection="column"
        backgroundColor={theme.background}
      >
        <box flexShrink={0} width="100%"><Status state={props.state} resources={props.resources} /></box>
        <box
          flexShrink={0}
          flexDirection="column"
          marginX={1}
          border={true}
          borderStyle="rounded"
          borderColor={state().busy ? theme.accent : theme.borderStrong}
          backgroundColor={theme.surfaceHigh}
        >
          <box flexDirection="row" width="100%" paddingLeft={1} paddingRight={1}>
            <text width={2} height={1} wrapMode="none" fg={theme.accent} attributes={bold}>❯</text>
            <textarea
              ref={props.setComposer}
              flexGrow={1}
              height={props.composerHeight()}
              minHeight={COMPOSER_MIN_LINES}
              maxHeight={COMPOSER_MAX_LINES}
              wrapMode="word"
              placeholder="ask thread, or / for commands…"
              placeholderColor={theme.muted}
              textColor={theme.text}
              focusedTextColor={theme.text}
              backgroundColor={theme.surfaceHigh}
              focusedBackgroundColor={theme.surfaceHigh}
              cursorColor={theme.accent}
              selectionBg={theme.selection}
              selectionFg={theme.selectionText}
              keyBindings={COMPOSER_KEY_BINDINGS}
              onContentChange={() => {
                const editor = props.composer();
                props.setComposerText(editor?.plainText ?? "");
                props.setComposerCursor(editor?.cursorOffset ?? 0);
                props.setForcePathCompletion(false);
              }}
              onCursorChange={() => {
                const editor = props.composer();
                props.setComposerCursor(editor?.cursorOffset ?? 0);
                props.setForcePathCompletion(false);
              }}
              onSubmit={() => {
                const editor = props.composer();
                if (!editor || state().busy) return;
                const input = editor.plainText;
                editor.clear();
                props.setComposerText("");
                props.setComposerCursor(0);
                props.setForcePathCompletion(false);
                void props.controller.submit(input);
              }}
            />
            {/* Sole hint, riding on the textarea's first line instead of
                taking its own row. */}
            <text height={1} wrapMode="none" fg={theme.faint}> @ add files</text>
          </box>
        </box>
        <box flexShrink={0} width="100%">
          <Footer state={props.state} meta={props.meta} resources={props.resources} width={props.terminalWidth} />
        </box>
      </box>
    </box>
  );
}
