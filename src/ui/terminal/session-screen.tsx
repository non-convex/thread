import type { KeyBinding, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { createMemo, For, Show, type Accessor } from "solid-js";
import { COMPACTION_TRIGGER_RATIO } from "../../context/budget.js";
import { statusLineParts, type AskScreen, type LiveTurn, type ModelPickerScreen, type RewindScreen, type SubagentSettingsScreen, type TranscriptItem, type UiState } from "../state.js";
import type { ComposerSuggestion } from "./completion.js";
import { type TerminalMeta, type ThreadTuiViewModel } from "./controller.js";
import type { ThreadViewResources } from "./resources.js";
import { modelDetail, selectedWindow } from "./screens.js";
import { wheelScrollAcceleration } from "./scroll.js";
import { SpinnerText, tuiAnimationTime } from "./spinner.js";
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

/**
 * Warn below the compaction trigger, not above it: at 80% automatic compaction had
 * already fired at 78%, so the warning colour could never actually be observed.
 */
export const CONTEXT_WARN_PERCENT = Math.round(COMPACTION_TRIGGER_RATIO * 100) - 10;

/** An em dash reads as "not measured yet", which a bare 0% would misreport. */
export function cacheHitLabel(percent: number | null): string {
  return percent === null ? "cache —" : `cache ${percent}%`;
}

/**
 * Suffixes the cache reading with why the last turn missed, so a dropped prefix
 * is diagnosable in place: an expired TTL, a model switch, or new content spliced
 * into the prefix. Silent when the last turn hit.
 */
export function cacheMissHint(
  reason: "idle" | "model-changed" | "prefix-changed" | null,
  missedTokens: number,
): string {
  if (!reason || missedTokens <= 0) return "";
  const labels = { idle: "idle", "model-changed": "model", "prefix-changed": "prefix" } as const;
  return ` ↓${formatTokenCount(missedTokens)} ${labels[reason]}`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

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
      <text height={1} wrapMode="none" truncate={true} flexShrink={1} fg={theme().softText}>session {state().sessionId.slice(0, 12)}</text>
      <Show when={meta().gitBranch}>
        <text height={1} wrapMode="none" fg={theme().border}>  │  </text>
        <text height={1} wrapMode="none" fg={theme().faint}>⎇ </text>
        <text height={1} wrapMode="none" truncate={true} flexShrink={1} fg={theme().softText}>{meta().gitBranch}</text>
      </Show>
      <Show when={!compact()}>
        <text height={1} wrapMode="none" fg={theme().border}>  │  </text>
        <text height={1} wrapMode="none" fg={meterColor()}>{contextMeter(meta().contextPercent)}</text>
        <text height={1} wrapMode="none" fg={theme().muted}> ctx {meta().contextPercent}%</text>
      </Show>
      <Show when={!narrow()}>
        <text height={1} wrapMode="none" fg={theme().faint}> · {cacheHitLabel(meta().cacheHitPercent)}</text>
        <Show when={cacheMissHint(meta().cacheMissReason, meta().cacheMissedTokens)}>
          <text height={1} wrapMode="none" fg={theme().warning}>
            {cacheMissHint(meta().cacheMissReason, meta().cacheMissedTokens)}
          </text>
        </Show>
      </Show>
      <box flexGrow={1} minWidth={1} />
      <text height={1} wrapMode="none" fg={theme().softText} attributes={bold}>{meta().modelName}</text>
      <Show when={meta().supportsThinking}>
        <text height={1} wrapMode="none" fg={theme().muted}> · {meta().thinkingLevel}</text>
        {/* The keybinding is one-time teaching, so it yields space first. */}
        <Show when={!narrow()}>
          <text height={1} wrapMode="none" fg={theme().faint}> ⇧⇥</text>
        </Show>
      </Show>
    </box>
  );
}

function Status(props: { state: Accessor<UiState>; resources: ThreadViewResources }) {
  const state = props.state;
  const theme = () => props.resources.theme;
  const parts = createMemo(() => {
    const snapshot = state();
    const running = snapshot.busy && snapshot.turnStartedAt !== undefined && snapshot.turnFinishedAt === undefined;
    return statusLineParts(snapshot, running ? tuiAnimationTime() : Date.now());
  });
  const noticeLevel = () => state().notice?.level;
  const color = () => state().busy
    ? theme().spark
    : noticeLevel() === "error"
      ? theme().error
      : noticeLevel() === "success"
        ? theme().success
        : theme().muted;
  return (
    <box flexDirection="row" width="100%" height={1} paddingX={1}>
      <Show when={state().busy}>
        <SpinnerText fg={theme().spark} />
        <text width={1} height={1}> </text>
      </Show>
      <Show when={parts().elapsed}>
        <text height={1} wrapMode="none" fg={theme().faint}>{parts().elapsed} </text>
      </Show>
      <text flexGrow={1} height={1} wrapMode="none" fg={color()} truncate={true}>
        {parts().main}
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
              fg={index() === props.selected ? props.resources.theme.sparkAlt : props.resources.theme.text}
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
  /** View-side selection signal — moving it must not notify the controller. */
  selected: Accessor<number>;
  /** True between an arrow-key move and the next controller notify. */
  navigated: Accessor<boolean>;
  resources: ThreadViewResources;
  /** Interior width of the floating panel (outer minus border and padding). */
  contentWidth: Accessor<number>;
}) {
  const theme = () => props.resources.theme;
  const visible = createMemo(() =>
    selectedWindow(props.screen().models, props.selected(), MODEL_OVERLAY_MAX_ROWS));
  return (
    // Inside a bordered box, OpenTUI 0.5.7 lets flexGrow/stretch children
    // overshoot the right border by ~2 cells; explicit widths clip exactly.
    <box flexDirection="column" width={props.contentWidth()} paddingX={1}>
      <box flexDirection="row" width={props.contentWidth() - 2} height={1}>
        <text width={Math.max(8, props.contentWidth() - 23)} flexShrink={1} height={1} wrapMode="none" truncate={true} fg={theme().faint}>
          {props.screen().scope === "all"
            ? `all models · ${props.screen().target === "main" ? "main" : "implementation-worker"}`
            : props.screen().target === "main"
              ? "configured models · /model all for the full catalog"
              : "worker models · /subagent on all for the full catalog"}
        </text>
        <text height={1} wrapMode="none" fg={theme().faint}>
          {props.screen().target === "main" ? "↑/↓ · ⏎ switch · esc" : "↑/↓ · ⏎ enable · esc"}
        </text>
      </box>
      <For each={visible()}>
        {({ item: model, index }) => {
          const selected = () => index === props.selected();
          const current = () =>
            model.providerId === props.screen().currentProviderId && model.modelId === props.screen().currentModelId;
          return (
            <box
              flexDirection="row"
              width={props.contentWidth() - 2}
              height={1}
              backgroundColor={selected() ? theme().surfaceHigh : "transparent"}
            >
              <text width={2} height={1} wrapMode="none" fg={selected() ? theme().sparkAlt : theme().accent}>
                {selected() ? "▸ " : current() ? "● " : "  "}
              </text>
              <text
                width={30}
                flexShrink={1}
                height={1}
                wrapMode="none"
                truncate={true}
                fg={selected() ? theme().sparkAlt : current() ? theme().accent : theme().text}
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
          <SpinnerText fg={theme().spark} />
          <text height={1} wrapMode="none" fg={theme().spark}>
            {props.screen().target === "main" ? " switching model…" : " enabling subagent…"}
          </text>
        </box>
      </Show>
      {/* Stale errors drop as soon as the selection moves again. */}
      <Show when={props.screen().error !== undefined && !props.navigated()}>
        <text width={props.contentWidth() - 2} height={1} wrapMode="none" truncate={true} fg={theme().error}>{props.screen().error}</text>
      </Show>
    </box>
  );
}

function SubagentSettingsOverlay(props: {
  screen: Accessor<SubagentSettingsScreen>;
  selected: Accessor<number>;
  resources: ThreadViewResources;
  contentWidth: Accessor<number>;
}) {
  const theme = () => props.resources.theme;
  const options = [
    { label: "Off", description: "Hide delegation tools and run only the main agent" },
    { label: "On", description: "Choose a worker model, then enable implementation workers" },
  ] as const;
  return (
    <box flexDirection="column" width={props.contentWidth()} paddingX={1}>
      <box flexDirection="row" width={props.contentWidth() - 2} height={1}>
        <text flexGrow={1} height={1} wrapMode="none" fg={theme().faint}>subagent mode</text>
        <text height={1} wrapMode="none" fg={theme().faint}>↑/↓ · ⏎ select · esc</text>
      </box>
      <For each={options}>
        {(option, index) => {
          const selected = () => index() === props.selected();
          const current = () => props.screen().enabled === (index() === 1);
          return (
            <box
              flexDirection="row"
              width={props.contentWidth() - 2}
              height={1}
              backgroundColor={selected() ? theme().surfaceHigh : "transparent"}
            >
              <text width={2} height={1} wrapMode="none" fg={selected() ? theme().sparkAlt : theme().accent}>
                {selected() ? "▸ " : current() ? "● " : "  "}
              </text>
              <text width={8} height={1} wrapMode="none" fg={selected() ? theme().sparkAlt : theme().text} attributes={selected() ? bold : 0}>
                {option.label}
              </text>
              <text flexGrow={1} height={1} wrapMode="none" truncate={true} fg={selected() ? theme().softText : theme().muted}>
                {option.description}
              </text>
            </box>
          );
        }}
      </For>
      <Show when={props.screen().busy}>
        <box flexDirection="row" width={props.contentWidth() - 2} height={1}>
          <SpinnerText fg={theme().spark} />
          <text height={1} wrapMode="none" fg={theme().spark}> updating subagent mode…</text>
        </box>
      </Show>
      <Show when={props.screen().error !== undefined}>
        <text width={props.contentWidth() - 2} height={1} wrapMode="none" truncate={true} fg={theme().error}>{props.screen().error}</text>
      </Show>
    </box>
  );
}

/* Bare `/rewind` floats the same kind of panel as /model: one row per user
 * message, newest first; enter twice to rewind before the selected turn. */
const REWIND_OVERLAY_MAX_ROWS = 8;

function rewindTime(startedAt: number): string {
  const date = new Date(startedAt);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function RewindOverlay(props: {
  screen: Accessor<RewindScreen>;
  /** View-side selection signal — moving it must not notify the controller. */
  selected: Accessor<number>;
  /** True between an arrow-key move and the next controller notify. */
  navigated: Accessor<boolean>;
  resources: ThreadViewResources;
  /** Interior width of the floating panel (outer minus border and padding). */
  contentWidth: Accessor<number>;
}) {
  const theme = () => props.resources.theme;
  const visible = createMemo(() =>
    selectedWindow(props.screen().items, props.selected(), REWIND_OVERLAY_MAX_ROWS));
  const selectedItem = () => props.screen().items[props.selected()];
  const rewindConfirm = () => {
    const screen = props.screen();
    return screen.type === "rewind" && screen.confirm;
  };
  return (
    <box flexDirection="column" width={props.contentWidth()} paddingX={1}>
      <box flexDirection="row" width={props.contentWidth() - 2} height={1}>
        <text width={Math.max(8, props.contentWidth() - 23)} flexShrink={1} height={1} wrapMode="none" truncate={true} fg={theme().faint}>
          rewind to before a user message
        </text>
        <text height={1} wrapMode="none" fg={theme().faint}>↑/↓ · ⏎ select · esc</text>
      </box>
      <For each={visible()}>
        {({ item, index }) => {
          const selected = () => index === props.selected();
          return (
            <box
              flexDirection="row"
              width={props.contentWidth() - 2}
              height={1}
              backgroundColor={selected() ? theme().surfaceHigh : "transparent"}
            >
              <text width={2} height={1} wrapMode="none" fg={theme().sparkAlt}>
                {selected() ? "▸ " : "  "}
              </text>
              <text
                width={Math.max(4, props.contentWidth() - 11)}
                flexShrink={1}
                height={1}
                wrapMode="none"
                truncate={true}
                fg={selected() ? theme().text : theme().softText}
                attributes={selected() ? bold : 0}
              >
                {item.label}
              </text>
              <text width={7} height={1} wrapMode="none" fg={theme().faint}> {rewindTime(item.startedAt)}</text>
            </box>
          );
        }}
      </For>
      <Show when={rewindConfirm() && !props.navigated() && selectedItem() !== undefined}>
        <text width={props.contentWidth() - 2} height={1} wrapMode="none" truncate={true} fg={theme().warning}>
          ⏎ again to rewind before this message · old path retained · esc
        </text>
      </Show>
      <Show when={props.screen().busy}>
        <box flexDirection="row" width={props.contentWidth() - 2} height={1}>
          <SpinnerText fg={theme().spark} />
          <text height={1} wrapMode="none" fg={theme().spark}> rewinding…</text>
        </box>
      </Show>
      <Show when={props.screen().error !== undefined && !props.navigated()}>
        <text width={props.contentWidth() - 2} height={1} wrapMode="none" truncate={true} fg={theme().error}>{props.screen().error}</text>
      </Show>
    </box>
  );
}

/* The agent's question panel. Options carry a description, so each choice takes
 * two rows and the option count is capped low by the tool itself. */
const ASK_OVERLAY_MAX_OPTIONS = 4;

function AskOverlay(props: {
  screen: Accessor<AskScreen>;
  resources: ThreadViewResources;
  contentWidth: Accessor<number>;
}) {
  const theme = () => props.resources.theme;
  const question = () => props.screen().request.questions[props.screen().questionIndex];
  const total = () => props.screen().request.questions.length;
  const chosen = () => props.screen().chosen[props.screen().questionIndex] ?? [];
  const typing = () => props.screen().customText !== undefined;
  return (
    <box flexDirection="column" width={props.contentWidth()} paddingX={1}>
      <box flexDirection="row" width={props.contentWidth() - 2} height={1}>
        <text
          width={Math.max(8, props.contentWidth() - 26)}
          flexShrink={1}
          height={1}
          wrapMode="none"
          truncate={true}
          fg={theme().spark}
          attributes={bold}
        >
          {question()?.header ?? "question"}
          {total() > 1 ? `  ${props.screen().questionIndex + 1}/${total()}` : ""}
        </text>
        <text height={1} wrapMode="none" fg={theme().faint}>
          {typing() ? "⏎ submit · esc back" : question()?.multiple ? "space mark · ⏎ ok" : "↑/↓ · ⏎ ok · esc"}
        </text>
      </box>
      <text
        width={props.contentWidth() - 2}
        height={1}
        wrapMode="none"
        truncate={true}
        fg={theme().text}
      >
        {question()?.question ?? ""}
      </text>
      <Show when={!typing()}>
        <For each={question()?.options ?? []}>
          {(option, index) => {
            const active = () => index() === props.screen().selected;
            const marked = () => chosen().includes(index());
            return (
              <box
                flexDirection="row"
                width={props.contentWidth() - 2}
                height={1}
                backgroundColor={active() ? theme().surfaceHigh : "transparent"}
              >
                <text width={2} height={1} wrapMode="none" fg={theme().sparkAlt}>
                  {active() ? "▸ " : "  "}
                </text>
                <text width={2} height={1} wrapMode="none" fg={theme().sparkAlt}>
                  {question()?.multiple ? (marked() ? "◉ " : "○ ") : ""}
                </text>
                <text
                  width={Math.max(4, Math.floor((props.contentWidth() - 8) * 0.4))}
                  flexShrink={0}
                  height={1}
                  wrapMode="none"
                  truncate={true}
                  fg={active() ? theme().text : theme().softText}
                  attributes={active() ? bold : 0}
                >
                  {option.label}
                </text>
                <text
                  flexGrow={1}
                  flexShrink={1}
                  height={1}
                  wrapMode="none"
                  truncate={true}
                  fg={theme().faint}
                >
                  {option.description ? ` ${option.description}` : ""}
                </text>
              </box>
            );
          }}
        </For>
        <text width={props.contentWidth() - 2} height={1} wrapMode="none" truncate={true} fg={theme().faint}>
          type to answer in your own words
        </text>
      </Show>
      <Show when={typing()}>
        <box flexDirection="row" width={props.contentWidth() - 2} height={1}>
          <text width={2} height={1} wrapMode="none" fg={theme().spark}>› </text>
          <text
            flexGrow={1}
            flexShrink={1}
            height={1}
            wrapMode="none"
            truncate={true}
            fg={theme().text}
          >
            {props.screen().customText}
          </text>
          <text width={1} height={1} wrapMode="none" fg={theme().spark}>▌</text>
        </box>
      </Show>
    </box>
  );
}

export function SessionScreen(props: {
  controller: ThreadTuiViewModel;
  state: Accessor<UiState>;
  transcript: Accessor<readonly TranscriptItem[]>;
  liveTurn: Accessor<LiveTurn | undefined>;
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
  /** View-side selection shared by the floating picker panels. */
  overlaySelected: Accessor<number>;
  /** True between an overlay arrow-key move and the next controller notify. */
  overlayNavigated: Accessor<boolean>;
  composerHeight: Accessor<number>;
  terminalWidth: Accessor<number>;
  setScroll: (value: ScrollBoxRenderable) => void;
}) {
  const state = props.state;
  const theme = props.resources.theme;
  // status line + composer (border + textarea row) + footer
  const controlsHeight = () => props.composerHeight() + 4;
  const hasTranscript = () => props.transcript().length > 0 || props.liveTurn() !== undefined;
  const modelPicker = (): ModelPickerScreen | undefined =>
    state().screen.type === "model_picker" ? state().screen as ModelPickerScreen : undefined;
  const subagentSettings = (): SubagentSettingsScreen | undefined =>
    state().screen.type === "subagent_settings" ? state().screen as SubagentSettingsScreen : undefined;
  const rewindScreen = (): RewindScreen | undefined =>
    state().screen.type === "rewind" ? state().screen as RewindScreen : undefined;
  const pathPicker = (): RewindScreen | undefined => rewindScreen();
  /* Floating panels sit at left/right 1 with a rounded border, so their
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
  const subagentOverlayHeight = () => {
    const settings = subagentSettings();
    if (!settings) return 0;
    return 1 + 2 + (settings.busy ? 1 : 0) + (settings.error ? 1 : 0) + 2;
  };
  const rewindOverlayHeight = () => {
    const rewind = pathPicker();
    if (!rewind) return 0;
    // header + windowed rows + optional confirm/busy/error lines + border
    return 1 + Math.min(REWIND_OVERLAY_MAX_ROWS, rewind.items.length)
      + (rewind.confirm ? 1 : 0)
      + (rewind.busy ? 1 : 0) + (rewind.error ? 1 : 0) + 2;
  };
  const askScreen = (): AskScreen | undefined =>
    state().screen.type === "ask" ? state().screen as AskScreen : undefined;
  const askOverlayHeight = () => {
    const ask = askScreen();
    if (!ask) return 0;
    const question = ask.request.questions[ask.questionIndex];
    // header + question text + (options + hint | one input row) + border
    const body = ask.customText !== undefined
      ? 1
      : Math.min(ASK_OVERLAY_MAX_OPTIONS, question?.options.length ?? 0) + 1;
    return 2 + body + 2;
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
          <TranscriptTurnsView items={props.transcript()} resources={props.resources} />
          <Show when={props.liveTurn()}>
            {(live: Accessor<LiveTurn>) => (
              <LiveTurnView turn={live} label="thread" resources={props.resources} />
            )}
          </Show>
        </scrollbox>
      </Show>
      <Show when={modelPicker() === undefined && subagentSettings() === undefined && pathPicker() === undefined && props.suggestions().length > 0}>
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
      {/* Do NOT use Show's callback form here: the controller mutates the
          picker screen in place, so the object reference never changes and a
          Show-scoped accessor would freeze the selection highlight. */}
      <Show when={modelPicker() !== undefined}>
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
            screen={() => modelPicker() as ModelPickerScreen}
            selected={props.overlaySelected}
            navigated={props.overlayNavigated}
            resources={props.resources}
            contentWidth={overlayContentWidth}
          />
        </box>
      </Show>
      <Show when={subagentSettings() !== undefined}>
        <box
          position="absolute"
          right={1}
          bottom={controlsHeight()}
          left={1}
          height={subagentOverlayHeight()}
          zIndex={20}
          border={true}
          borderStyle="rounded"
          borderColor={theme.borderStrong}
          backgroundColor={theme.surface}
        >
          <SubagentSettingsOverlay
            screen={() => subagentSettings() as SubagentSettingsScreen}
            selected={props.overlaySelected}
            resources={props.resources}
            contentWidth={overlayContentWidth}
          />
        </box>
      </Show>
      <Show when={pathPicker() !== undefined}>
        <box
          position="absolute"
          right={1}
          bottom={controlsHeight()}
          left={1}
          height={rewindOverlayHeight()}
          zIndex={20}
          border={true}
          borderStyle="rounded"
          borderColor={theme.borderStrong}
          backgroundColor={theme.surface}
        >
          <RewindOverlay
            screen={() => pathPicker() as RewindScreen}
            selected={props.overlaySelected}
            navigated={props.overlayNavigated}
            resources={props.resources}
            contentWidth={overlayContentWidth}
          />
        </box>
      </Show>
      <Show when={askScreen() !== undefined}>
        <box
          position="absolute"
          right={1}
          bottom={controlsHeight()}
          left={1}
          height={askOverlayHeight()}
          zIndex={20}
          border={true}
          borderStyle="rounded"
          borderColor={theme.spark}
          backgroundColor={theme.surface}
        >
          <AskOverlay
            screen={() => askScreen() as AskScreen}
            resources={props.resources}
            contentWidth={overlayContentWidth}
          />
        </box>
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
          borderColor={state().busy ? theme.spark : theme.borderStrong}
          backgroundColor={theme.surfaceHigh}
        >
          <box flexDirection="row" width="100%" paddingLeft={1}>
            <text width={2} height={1} wrapMode="none" fg={theme.accent} attributes={bold}>❯</text>
            <textarea
              ref={props.setComposer}
              flexGrow={1}
              height={props.composerHeight()}
              minHeight={COMPOSER_MIN_LINES}
              maxHeight={COMPOSER_MAX_LINES}
              wrapMode="word"
              placeholder="ask thread, / for commands, @ to add files…"
              placeholderColor={theme.muted}
              textColor={theme.text}
              focusedTextColor={theme.text}
              backgroundColor={theme.surfaceHigh}
              focusedBackgroundColor={theme.surfaceHigh}
              cursorColor={theme.spark}
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
          </box>
        </box>
        <box flexShrink={0} width="100%">
          <Footer state={props.state} meta={props.meta} resources={props.resources} width={props.terminalWidth} />
        </box>
      </box>
    </box>
  );
}
