import type { KeyBinding, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { createMemo, For, Show, type Accessor } from "solid-js";
import { isSlashCommandInput } from "../../app/input-router.js";
import { COMPACTION_TRIGGER_RATIO } from "../../context/budget.js";
import { statusLineParts, type AgentPickerScreen, type AgentSettingsScreen, type AskScreen, type LiveTurn, type ModelPickerScreen, type RewindScreen, type TranscriptItem, type UiState } from "../state.js";
import type { ComposerImage } from "../images.js";
import type { ComposerSuggestion } from "./completion.js";
import { type TerminalMeta, type ThreadTuiViewModel } from "./controller.js";
import type { ThreadViewResources } from "./resources.js";
import { modelDetail, selectedWindow } from "./screens.js";
import { wheelScrollAcceleration } from "./scroll.js";
import { SpinnerText, tuiAnimationTime } from "./spinner.js";
import { LiveTurnView, TranscriptTurnsView, WelcomeView } from "./transcript.js";
import { bold, contextMeter, contextMeterColor, STATUS_ICONS, formatTokenCount } from "./theme.js";

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

function attachmentSummary(images: readonly ComposerImage[], busy: boolean): string {
  if (images.length === 0) return busy ? "reading clipboard…" : "";
  const details = images.map((image) => {
    const kind = image.mimeType.replace(/^image\//, "");
    return `${image.width}×${image.height} ${kind}`;
  });
  const prefix = images.length === 1 ? "image" : `${images.length} images`;
  return `${prefix} · ${details.join(" · ")}${busy ? " · reading clipboard…" : ""}`;
}

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

/**
 * Enhanced Footer with improved visual hierarchy and icons
 */
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
  const meterColor = () => contextMeterColor(meta().contextPercent, theme());
  
  return (
    <box flexDirection="row" width="100%" height={1} paddingX={1} backgroundColor={theme().surface}>
      {/* Session ID with icon - show more characters, allow wrapping */}
      <text height={1} wrapMode="none" fg={theme().faint}>⊙</text>
      <text 
        height={1} 
        wrapMode="none" 
        truncate={true} 
        flexShrink={2}
        minWidth={16}
        fg={theme().softText}
      > {state().sessionId}</text>
      
      {/* Git branch with icon */}
      <Show when={meta().gitBranch}>
        <text height={1} wrapMode="none" fg={theme().border}>  │  </text>
        <text height={1} wrapMode="none" fg={theme().accent}>⎇</text>
        <text height={1} wrapMode="none" truncate={true} flexShrink={3} fg={theme().softText}> {meta().gitBranch}</text>
      </Show>
      
      {/* Context meter - 8-cell precision with dynamic color */}
      <Show when={!compact()}>
        <text height={1} wrapMode="none" fg={theme().border}>  │  </text>
        <text height={1} wrapMode="none" fg={meterColor()}>{contextMeter(meta().contextPercent, 8)}</text>
        <text height={1} wrapMode="none" fg={theme().muted}> {meta().contextPercent}%</text>
      </Show>
      
      {/* Cache hit with lightning icon */}
      <Show when={!narrow()}>
        <text height={1} wrapMode="none" fg={theme().faint}> ⚡ {cacheHitLabel(meta().cacheHitPercent)}</text>
        <Show when={cacheMissHint(meta().cacheMissReason, meta().cacheMissedTokens)}>
          <text height={1} wrapMode="none" fg={theme().warning}>
            {cacheMissHint(meta().cacheMissReason, meta().cacheMissedTokens)}
          </text>
        </Show>
      </Show>
      
      <box flexGrow={1} minWidth={1} />
      
      {/* Model name - highlighted with accent color */}
      <text height={1} wrapMode="none" flexShrink={0} fg={theme().accent} attributes={bold}>{meta().modelName}</text>
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
  const theme = props.resources.theme;
  return (
    <box flexDirection="column" width={props.contentWidth()} paddingX={1} backgroundColor={theme.surface}>
      <For each={props.suggestions}>
        {(suggestion, index) => (
          <box
            flexDirection="row"
            width={props.contentWidth() - 2}
            height={1}
            backgroundColor={index() === props.selected ? theme.surfaceHigh : "transparent"}
          >
            <text
              width={14}
              height={1}
              wrapMode="none"
              truncate={true}
              fg={index() === props.selected ? theme.sparkAlt : theme.text}
              attributes={index() === props.selected ? bold : 0}
            >
              {index() === props.selected ? `${STATUS_ICONS.selected} ` : ""}{suggestion.label}
            </text>
            <text
              width={Math.max(4, props.contentWidth() - 16)}
              flexShrink={1}
              height={1}
              wrapMode="none"
              fg={index() === props.selected ? theme.softText : theme.muted}
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

/* The /agent model list rides on the session screen exactly like the "/" suggestion
 * popup: a small rounded panel floating above the composer instead of a
 * separate full-screen takeover. */
const MODEL_OVERLAY_MAX_ROWS = 8;

/**
 * Enhanced Model Picker Overlay with improved visual hierarchy
 */
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
  const rowWidth = () => props.contentWidth() - 2;
  const identifierWidth = createMemo(() => {
    const longest = props.screen().models.reduce(
      (length, model) => Math.max(length, `${model.providerId}/${model.modelId}`.length),
      8,
    );
    const proportionalLimit = Math.max(8, Math.floor(rowWidth() * 0.45));
    const available = Math.max(8, rowWidth() - 8);
    return Math.min(longest, proportionalLimit, available);
  });
  const detailWidth = () => Math.max(4, rowWidth() - identifierWidth() - 4);
  const title = () => {
    const target = props.screen().agentId === "main"
      ? "Main model"
      : props.screen().agentId === "dreamer"
        ? "Dreamer model"
        : "Implementation worker model";
    return props.screen().scope === "all" ? `${target} · all` : target;
  };
  return (
    // Inside a bordered box, OpenTUI 0.5.7 lets flexGrow/stretch children
    // overshoot the right border by ~2 cells; explicit widths clip exactly.
    <box flexDirection="column" width={props.contentWidth()} paddingX={1}>
      <box flexDirection="row" width={rowWidth()} height={1} marginBottom={1}>
        <text width={Math.max(8, props.contentWidth() - 23)} flexShrink={1} height={1} wrapMode="none" truncate={true} fg={theme().accent} attributes={bold}>
          {title()}
        </text>
        <text height={1} wrapMode="none" fg={theme().faint}>
          {props.screen().agentId === "main" ? "↑/↓ · ⏎ switch · esc" : "↑/↓ · ⏎ enable · esc"}
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
              width={rowWidth()}
              height={1}
              backgroundColor={selected() ? theme().surfaceHigh : "transparent"}
              paddingX={1}
            >
              <text width={2} height={1} wrapMode="none" fg={selected() ? theme().sparkAlt : current() ? theme().accent : theme().muted}>
                {selected() ? `${STATUS_ICONS.selected} ` : current() ? `${STATUS_ICONS.current} ` : "  "}
              </text>
              <text
                width={identifierWidth()}
                flexShrink={1}
                height={1}
                wrapMode="none"
                truncate={true}
                fg={selected() ? theme().sparkAlt : current() ? theme().accent : theme().text}
                attributes={selected() || current() ? bold : 0}
              >
                {model.providerId}/{model.modelId}
              </text>
              <text width={2} height={1} wrapMode="none">  </text>
              <text
                width={detailWidth()}
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
            {props.screen().agentId === "main" ? " switching model…" : " enabling agent…"}
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

function AgentPickerOverlay(props: {
  screen: Accessor<AgentPickerScreen>;
  selected: Accessor<number>;
  navigated: Accessor<boolean>;
  resources: ThreadViewResources;
  contentWidth: Accessor<number>;
}) {
  const theme = () => props.resources.theme;
  return (
    <box flexDirection="column" width={props.contentWidth()} paddingX={1}>
      <box flexDirection="row" width={props.contentWidth() - 2} height={1} marginBottom={1}>
        <text flexGrow={1} height={1} wrapMode="none" fg={theme().accent} attributes={bold}>⚙ Agents</text>
        <text height={1} wrapMode="none" fg={theme().faint}>↑/↓ · ⏎ configure · esc</text>
      </box>
      <For each={props.screen().agents}>
        {(agent, index) => {
          const selected = () => index() === props.selected();
          return (
            <box
              flexDirection="row"
              width={props.contentWidth() - 2}
              height={1}
              backgroundColor={selected() ? theme().surfaceHigh : "transparent"}
              paddingX={1}
            >
              <text width={2} height={1} wrapMode="none" fg={selected() ? theme().sparkAlt : agent.enabled ? theme().accent : theme().muted}>
                {selected() ? `${STATUS_ICONS.selected} ` : agent.enabled ? `${STATUS_ICONS.current} ` : "  "}
              </text>
              <text
                width={24}
                flexShrink={1}
                height={1}
                wrapMode="none"
                truncate={true}
                fg={selected() ? theme().sparkAlt : theme().text}
                attributes={selected() || agent.enabled ? bold : 0}
              >
                {agent.label}
              </text>
              <text
                flexGrow={1}
                flexShrink={1}
                height={1}
                wrapMode="none"
                truncate={true}
                fg={selected() ? theme().softText : theme().muted}
              >
                {agent.enabled ? "on" : "off"} · {agent.detail}
              </text>
            </box>
          );
        }}
      </For>
      <Show when={props.screen().busy}>
        <box flexDirection="row" width={props.contentWidth() - 2} height={1}>
          <SpinnerText fg={theme().spark} />
          <text height={1} wrapMode="none" fg={theme().spark}> opening agent…</text>
        </box>
      </Show>
      <Show when={props.screen().error !== undefined && !props.navigated()}>
        <text width={props.contentWidth() - 2} height={1} wrapMode="none" truncate={true} fg={theme().error}>{props.screen().error}</text>
      </Show>
    </box>
  );
}

/**
 * Enhanced Subagent Settings Overlay with improved visual hierarchy
 */
function AgentSettingsOverlay(props: {
  screen: Accessor<AgentSettingsScreen>;
  selected: Accessor<number>;
  resources: ThreadViewResources;
  contentWidth: Accessor<number>;
}) {
  const theme = () => props.resources.theme;
  const options = [
    { label: "Off", description: `Disable ${props.screen().label}` },
    { label: "On", description: `Choose a model, then enable ${props.screen().label}` },
  ] as const;
  return (
    <box flexDirection="column" width={props.contentWidth()} paddingX={1}>
      <box flexDirection="row" width={props.contentWidth() - 2} height={1} marginBottom={1}>
        <text flexGrow={1} height={1} wrapMode="none" fg={theme().accent} attributes={bold}>⚙ {props.screen().label}</text>
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
              paddingX={1}
            >
              <text width={2} height={1} wrapMode="none" fg={selected() ? theme().sparkAlt : current() ? theme().accent : theme().muted}>
                {selected() ? `${STATUS_ICONS.selected} ` : current() ? `${STATUS_ICONS.current} ` : "  "}
              </text>
              <text width={8} height={1} wrapMode="none" fg={selected() ? theme().sparkAlt : theme().text} attributes={selected() || current() ? bold : 0}>
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
          <text height={1} wrapMode="none" fg={theme().spark}> updating agent…</text>
        </box>
      </Show>
      <Show when={props.screen().error !== undefined}>
        <text width={props.contentWidth() - 2} height={1} wrapMode="none" truncate={true} fg={theme().error}>{props.screen().error}</text>
      </Show>
    </box>
  );
}

/* Bare `/rewind` floats the same kind of panel as /agent model: one row per user
 * message, newest first; enter twice to rewind before the selected turn. */
const REWIND_OVERLAY_MAX_ROWS = 8;

function rewindTime(startedAt: number): string {
  const date = new Date(startedAt);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Enhanced Rewind Overlay with improved visual hierarchy
 */
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
      <box flexDirection="row" width={props.contentWidth() - 2} height={1} marginBottom={1}>
        <text width={Math.max(8, props.contentWidth() - 23)} flexShrink={1} height={1} wrapMode="none" truncate={true} fg={theme().accent} attributes={bold}>
          ⎌ Rewind to before a user message
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
              paddingX={1}
            >
              <text width={2} height={1} wrapMode="none" fg={theme().sparkAlt}>
                {selected() ? `${STATUS_ICONS.selected} ` : "  "}
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

/**
 * Enhanced Ask Overlay with improved visual hierarchy
 */
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
      <box flexDirection="row" width={props.contentWidth() - 2} height={1} marginBottom={1}>
        <text
          width={Math.max(8, props.contentWidth() - 26)}
          flexShrink={1}
          height={1}
          wrapMode="none"
          truncate={true}
          fg={theme().spark}
          attributes={bold}
        >
          {STATUS_ICONS.info} {question()?.header ?? "question"}
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
                paddingX={1}
              >
                <text width={2} height={1} wrapMode="none" fg={theme().sparkAlt}>
                  {active() ? `${STATUS_ICONS.selected} ` : "  "}
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
  attachments: Accessor<readonly ComposerImage[]>;
  setAttachments: (images: ComposerImage[]) => void;
  pasteBusy: Accessor<boolean>;
  setScroll: (value: ScrollBoxRenderable) => void;
}) {
  const state = props.state;
  const theme = props.resources.theme;
  const attachmentLine = () => props.attachments().length > 0 || props.pasteBusy() ? 1 : 0;
  // status line + composer (border + textarea row + optional attachment row) + footer
  const controlsHeight = () => props.composerHeight() + 4 + attachmentLine();
  const hasTranscript = () => props.transcript().length > 0 || props.liveTurn() !== undefined;
  const modelPicker = (): ModelPickerScreen | undefined =>
    state().screen.type === "model_picker" ? state().screen as ModelPickerScreen : undefined;
  const agentPicker = (): AgentPickerScreen | undefined =>
    state().screen.type === "agent_picker" ? state().screen as AgentPickerScreen : undefined;
  const agentSettings = (): AgentSettingsScreen | undefined =>
    state().screen.type === "agent_settings" ? state().screen as AgentSettingsScreen : undefined;
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
    // Header, its one-row margin, windowed rows, optional status, and border.
    return 2 + Math.min(MODEL_OVERLAY_MAX_ROWS, picker.models.length)
      + (picker.busy ? 1 : 0) + (picker.error ? 1 : 0) + 2;
  };
  const agentPickerOverlayHeight = () => {
    const picker = agentPicker();
    if (!picker) return 0;
    return 1 + picker.agents.length + (picker.busy ? 1 : 0) + (picker.error ? 1 : 0) + 2;
  };
  const subagentOverlayHeight = () => {
    const settings = agentSettings();
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
      <Show when={modelPicker() === undefined && agentPicker() === undefined && agentSettings() === undefined && pathPicker() === undefined && props.suggestions().length > 0}>
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
      <Show when={agentPicker() !== undefined}>
        <box
          position="absolute"
          right={1}
          bottom={controlsHeight()}
          left={1}
          height={agentPickerOverlayHeight()}
          zIndex={20}
          border={true}
          borderStyle="rounded"
          borderColor={theme.borderStrong}
          backgroundColor={theme.surface}
        >
          <AgentPickerOverlay
            screen={() => agentPicker() as AgentPickerScreen}
            selected={props.overlaySelected}
            navigated={props.overlayNavigated}
            resources={props.resources}
            contentWidth={overlayContentWidth}
          />
        </box>
      </Show>
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
      <Show when={agentSettings() !== undefined}>
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
          <AgentSettingsOverlay
            screen={() => agentSettings() as AgentSettingsScreen}
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
          <Show when={props.attachments().length > 0 || props.pasteBusy()}>
            <box flexDirection="row" width="100%" height={1} paddingLeft={1} paddingRight={1}>
              <text
                flexGrow={1}
                height={1}
                wrapMode="none"
                truncate={true}
                fg={theme.muted}
              >
                {attachmentSummary(props.attachments(), props.pasteBusy())}
              </text>
            </box>
          </Show>
          <box flexDirection="row" width="100%" paddingLeft={1}>
            <text width={2} height={1} wrapMode="none" fg={theme.accent} attributes={bold}>❯</text>
            <textarea
              ref={props.setComposer}
              flexGrow={1}
              height={props.composerHeight()}
              minHeight={COMPOSER_MIN_LINES}
              maxHeight={COMPOSER_MAX_LINES}
              wrapMode="word"
              placeholder="ask thread, / commands, @ files, Ctrl+V image…"
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
                if (props.pasteBusy()) {
                  props.controller.note("Wait for the clipboard image to finish processing.", "info");
                  return;
                }
                const images = [...props.attachments()];
                const command = isSlashCommandInput(input);
                if (images.length > 0 && !command && !props.controller.meta.acceptsImages) {
                  props.controller.note(
                    "Current model does not accept images. Use /model to pick a vision model.",
                    "error",
                  );
                  return;
                }
                editor.clear();
                props.setComposerText("");
                props.setComposerCursor(0);
                props.setForcePathCompletion(false);
                if (!command) props.setAttachments([]);
                void props.controller.submit(input, command ? [] : images);
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
