import { MouseButton, type MouseEvent } from "@opentui/core";
import { createMemo, For, Index, Match, Show, Switch, type Accessor } from "solid-js";
import stringWidth from "string-width";
import { filteredModels, type AgentPickerScreen, type AgentSettingsScreen, type AskScreen, type CommandPickerScreen, type ModelPickerScreen, type RewindScreen, type UiScreen } from "../state.js";
import type { ComposerSuggestion } from "./completion.js";
import type { ThreadViewResources } from "./resources.js";
import { AgentPickerOverlay, AgentSettingsOverlay, ModelPickerOverlay, MODEL_OVERLAY_MAX_ROWS, type OverlayProps } from "./agent-overlays.js";
import { selectedWindow } from "./screens.js";
import { bold, STATUS_ICONS } from "./theme.js";
import { Line, Panel, Row, RuleFill } from "./widgets.js";

export const COMMAND_OVERLAY_MAX_ITEMS = 6;
export const REWIND_OVERLAY_MAX_ROWS = 8;
/** Title rule, blank row, body and optional status lines share one sizing rule. */
export function overlayHeight(screen: UiScreen, width: number): number {
  let rows: number;
  switch (screen.type) {
    case "command_picker": rows = Math.max(1, Math.min(COMMAND_OVERLAY_MAX_ITEMS, screen.items.length) * 2); break;
    case "model_picker": rows = 2 + Math.max(1, Math.min(MODEL_OVERLAY_MAX_ROWS, filteredModels(screen).length)); break;
    case "agent_picker": rows = screen.agents.length; break;
    case "agent_settings": rows = 3 + (screen.details?.length ?? 0); break;
    case "rewind": rows = Math.min(REWIND_OVERLAY_MAX_ROWS, screen.items.length) + Number(screen.confirm); break;
    case "ask": return askHeight(askLayout(screen, width));
    default: return 0;
  }
  return 2 + rows + Number(screen.busy) + Number(Boolean(screen.error));
}

export function SessionOverlay(props: OverlayProps<UiScreen> & { onAskSelect: (index: number | undefined) => void }) {
  // Read the screen through the original accessor: panels are mutated in place.
  return <Switch>
    <Match when={props.screen().type === "command_picker"}>
      <CommandPickerOverlay {...props} screen={() => props.screen() as CommandPickerScreen} />
    </Match>
    <Match when={props.screen().type === "model_picker"}>
      <ModelPickerOverlay {...props} screen={() => props.screen() as ModelPickerScreen} />
    </Match>
    <Match when={props.screen().type === "agent_picker"}>
      <AgentPickerOverlay {...props} screen={() => props.screen() as AgentPickerScreen} />
    </Match>
    <Match when={props.screen().type === "agent_settings"}>
      <AgentSettingsOverlay {...props} screen={() => props.screen() as AgentSettingsScreen} />
    </Match>
    <Match when={props.screen().type === "rewind"}>
      <RewindOverlay {...props} screen={() => props.screen() as RewindScreen} />
    </Match>
    <Match when={props.screen().type === "ask"}>
      <AskOverlay {...props} screen={() => props.screen() as AskScreen} onSelect={props.onAskSelect} />
    </Match>
  </Switch>;
}

export function ComposerSuggestions(props: {
  suggestions: readonly ComposerSuggestion[];
  selected: number;
  resources: ThreadViewResources;
  contentWidth: Accessor<number>;
}) {
  const theme = props.resources.theme;
  return <box flexDirection="column" width={props.contentWidth()} paddingX={1} backgroundColor={theme.surface}>
    <Row width={props.contentWidth() - 2}>
      <RuleFill color={theme.borderStrong} />
      <Line flexShrink={0} fg={theme.faint} truncate={false}> ↑/↓ · tab complete </Line>
      <RuleFill width={2} color={theme.borderStrong} />
    </Row>
    <For each={props.suggestions}>{(suggestion, index) =>
      <Row width={props.contentWidth() - 2} paddingX={1} backgroundColor={index() === props.selected ? theme.surfaceHigh : "transparent"}>
        <Line width={16} fg={index() === props.selected ? theme.sparkAlt : theme.text} attributes={index() === props.selected ? bold : 0}>
          {index() === props.selected ? `${STATUS_ICONS.selected} ` : "  "}{suggestion.label}
        </Line>
        <Line width={Math.max(4, props.contentWidth() - 20)} flexShrink={1} fg={index() === props.selected ? theme.softText : theme.muted}>
          {suggestion.description}
        </Line>
      </Row>
    }</For>
  </box>;
}

export function CommandPickerOverlay(props: OverlayProps<CommandPickerScreen>) {
  const theme = props.resources.theme;
  const rowWidth = () => props.contentWidth() - 2;
  const visible = createMemo(() => selectedWindow(props.screen().items, props.selected(), COMMAND_OVERLAY_MAX_ITEMS));
  return <Panel width={props.contentWidth()} resources={props.resources} title={props.screen().title}
    hint={props.screen().items[props.selected()]?.submit === false ? "↑/↓ · ⏎ edit · esc" : "↑/↓ · ⏎ select · esc"}
    busy={props.screen().busy ? "opening…" : undefined} spinner={false} error={props.navigated() ? undefined : props.screen().error}>
    <For each={visible()}>{({ item, index }) =>
      <box flexDirection="column" width={rowWidth()} height={2} backgroundColor={index === props.selected() ? theme.surfaceHigh : "transparent"}>
        <Line width={rowWidth()} fg={index === props.selected() ? theme.sparkAlt : theme.text} attributes={index === props.selected() ? bold : 0}>
          {index === props.selected() ? `${STATUS_ICONS.selected} ` : "  "}{item.current ? `${STATUS_ICONS.current} ` : ""}{item.label}
        </Line>
        <Line width={rowWidth()} fg={theme.muted}>  {item.description}</Line>
      </box>
    }</For>
    <Show when={!props.screen().items.length}>
      <Line width={rowWidth()} fg={theme.muted}>{props.screen().emptyText ?? "No options available."}</Line>
    </Show>
  </Panel>;
}

function rewindTime(startedAt: number): string {
  const date = new Date(startedAt);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function RewindOverlay(props: OverlayProps<RewindScreen>) {
  const theme = props.resources.theme;
  const visible = createMemo(() => selectedWindow(props.screen().items, props.selected(), REWIND_OVERLAY_MAX_ROWS));
  return <Panel width={props.contentWidth()} resources={props.resources} title="⎌ Rewind to before a user message"
    hint="↑/↓ · ⏎ select · esc"
    busy={props.screen().busy ? "rewinding…" : undefined} error={props.navigated() ? undefined : props.screen().error}>
    <For each={visible()}>{({ item, index }) =>
      <Row width={props.contentWidth() - 2} paddingX={1} backgroundColor={index === props.selected() ? theme.surfaceHigh : "transparent"}>
        <Line width={2} fg={theme.sparkAlt}>{index === props.selected() ? `${STATUS_ICONS.selected} ` : "  "}</Line>
        <Line width={Math.max(4, props.contentWidth() - 11)} flexShrink={1}
          fg={index === props.selected() ? theme.text : theme.softText} attributes={index === props.selected() ? bold : 0}>{item.label}</Line>
        <Line width={7} fg={theme.faint}> {rewindTime(item.startedAt)}</Line>
      </Row>
    }</For>
    <Show when={props.screen().confirm && !props.navigated() && props.screen().items[props.selected()] !== undefined}>
      <Line width={props.contentWidth() - 2} fg={theme.warning}>⏎ again to rewind before this message · old path retained · esc</Line>
    </Show>
  </Panel>;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Caps keep an unusually long question inside the terminal; the free-text field shows its latest lines.
const ASK_MAX_LINES = { question: 6, label: 2, description: 2, input: 4 } as const;
const ASK_MIN_INPUT_LINES = 2;

/** Words stay whole when they fit; wide graphemes and over-long words break anywhere. */
function wordTokens(text: string): string[] {
  const tokens: string[] = [];
  let word = "";
  for (const { segment } of graphemes.segment(text)) {
    if (/^\s+$/.test(segment) || stringWidth(segment) > 1) {
      if (word) tokens.push(word);
      word = "";
      tokens.push(segment);
    } else word += segment;
  }
  if (word) tokens.push(word);
  return tokens;
}

/**
 * Wraps by terminal cells so the rendered rows and the reserved overlay height agree.
 * Word mode drops spaces at wrap points; character mode keeps typed text exactly.
 */
function wrapCells(text: string, width: number, words = true): string[] {
  const max = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    let used = 0;
    const put = (piece: string) => {
      const cells = stringWidth(piece);
      if (used > 0 && used + cells > max) {
        lines.push(words ? line.trimEnd() : line);
        line = "";
        used = 0;
      }
      if (words && !line && !piece.trim()) return;
      line += piece;
      used += cells;
    };
    const tokens = words ? wordTokens(paragraph) : Array.from(graphemes.segment(paragraph), ({ segment }) => segment);
    for (const token of tokens) {
      if (stringWidth(token) <= max) put(token);
      else for (const { segment } of graphemes.segment(token)) put(segment);
    }
    lines.push(words ? line.trimEnd() : line);
  }
  return lines;
}

function clampLines(lines: string[], max: number, width: number): string[] {
  if (lines.length <= max) return lines;
  const last = [...graphemes.segment(lines[max - 1]!)].map(({ segment }) => segment);
  while (last.length && stringWidth(last.join("")) > width - 1) last.pop();
  return [...lines.slice(0, max - 1), `${last.join("")}…`];
}

interface AskLayout {
  question: string[];
  options: { label: string[]; description: string[] }[];
  input: string[];
  /** Row of the free-text field that ends with the cursor. */
  cursorRow: number;
}

/**
 * Panel padding and option rows each take one column per side, so text gets `width - 4` cells.
 * Option text also leaves room for the selection marker and, for multiple choice, the checkbox.
 */
function askLayout(screen: AskScreen, width: number): AskLayout {
  const question = screen.request.questions[screen.questionIndex];
  const body = Math.max(8, width - 4);
  const optionWidth = Math.max(4, body - (question?.multiple ? 4 : 2));
  const inputWidth = Math.max(4, body - 2);
  const input = screen.customText === undefined ? [""] : wrapCells(screen.customText, inputWidth, false);
  // The cursor needs one free cell after the text.
  if (stringWidth(input.at(-1)!) >= inputWidth) input.push("");
  const visibleInput = input.slice(-ASK_MAX_LINES.input);
  const cursorRow = visibleInput.length - 1;
  while (visibleInput.length < ASK_MIN_INPUT_LINES) visibleInput.push("");
  return {
    question: clampLines(wrapCells(question?.question ?? "", body), ASK_MAX_LINES.question, body),
    options: (question?.options ?? []).map((option) => ({
      label: clampLines(wrapCells(option.label, optionWidth), ASK_MAX_LINES.label, optionWidth),
      description: option.description
        ? clampLines(wrapCells(option.description, optionWidth), ASK_MAX_LINES.description, optionWidth) : [],
    })),
    input: visibleInput,
    cursorRow,
  };
}

/** Title rule and its blank row, question, blank, options, blank, free-text field. */
function askHeight(layout: AskLayout): number {
  const options = layout.options.reduce((rows, option) => rows + option.label.length + option.description.length, 0);
  return 2 + layout.question.length + 1 + options + 1 + layout.input.length;
}

export function AskOverlay(props: Pick<OverlayProps<AskScreen>, "screen" | "resources" | "contentWidth"> & {
  onSelect: (index: number | undefined) => void;
}) {
  const theme = props.resources.theme;
  const layout = createMemo(() => askLayout(props.screen(), props.contentWidth()));
  const question = () => props.screen().request.questions[props.screen().questionIndex];
  const total = () => props.screen().request.questions.length;
  const chosen = () => props.screen().chosen[props.screen().questionIndex] ?? [];
  const typing = () => props.screen().customText !== undefined;
  const multiple = () => question()?.multiple === true;
  const rowWidth = () => props.contentWidth() - 2;
  const textWidth = () => rowWidth() - 2;
  const indent = () => " ".repeat(multiple() ? 4 : 2);
  const title = () => `${STATUS_ICONS.info} ${question()?.header ?? "Question"}${total() > 1 ? ` · ${props.screen().questionIndex + 1}/${total()}` : ""}`;
  const hint = () => typing() ? "⏎ submit · ↑/↓ / tab / esc options"
    : multiple() ? "↑/↓ · space mark · tab write · ⏎ ok · esc" : "↑/↓ · tab write · ⏎ ok · esc";
  const select = (event: MouseEvent, index: number | undefined) => {
    if (event.button !== MouseButton.LEFT) return;
    event.preventDefault();
    event.stopPropagation();
    props.onSelect(index);
  };
  return <Panel width={props.contentWidth()} resources={props.resources} title={title()} titleColor={theme.spark} hint={hint()}>
    <box flexDirection="column" width={rowWidth()} paddingX={1}>
      <Index each={layout().question}>{(line) => <Line width={textWidth()} fg={theme.text} attributes={bold}>{line()}</Line>}</Index>
    </box>
    <box flexDirection="column" width={rowWidth()} marginTop={1}>
      <Index each={layout().options}>{(option, index) => {
        // While typing, Enter submits the free text, so no option is shown as the pending choice.
        const active = () => !typing() && index === props.screen().selected;
        const marked = () => chosen().includes(index);
        return <box flexDirection="column" width={rowWidth()} paddingX={1} backgroundColor={active() ? theme.surfaceHigh : "transparent"}
          onMouseDown={(event) => select(event, index)}>
          <Index each={option().label}>{(line, row) =>
            <Row width={textWidth()}>
              <Line width={2} flexShrink={0} fg={theme.sparkAlt}>{row === 0 && active() ? `${STATUS_ICONS.selected} ` : "  "}</Line>
              <Show when={multiple()}>
                <Line width={2} flexShrink={0} fg={marked() ? theme.spark : theme.faint}>{row === 0 ? (marked() ? "◉ " : "○ ") : "  "}</Line>
              </Show>
              <Line flexGrow={1} flexShrink={1} attributes={active() ? bold : 0}
                fg={active() ? theme.sparkAlt : typing() ? theme.muted : theme.text}>{line()}</Line>
            </Row>
          }</Index>
          <Index each={option().description}>{(line) =>
            <Line width={textWidth()} fg={active() ? theme.softText : theme.muted}>{indent()}{line()}</Line>
          }</Index>
        </box>;
      }}</Index>
    </box>
    {/* A recessed field on the panel surface; it always shows, so typing never changes the layout above. */}
    <box flexDirection="column" width={rowWidth()} marginTop={1} paddingX={1} backgroundColor={theme.background}
      onMouseDown={(event) => select(event, undefined)}>
      <Index each={layout().input}>{(line, row) =>
        <Row width={textWidth()}>
          <Line width={2} flexShrink={0} fg={typing() ? theme.spark : theme.faint} attributes={bold}>{row === 0 ? "›" : ""}</Line>
          <Show when={typing()} fallback={
            <Line flexGrow={1} flexShrink={1} fg={theme.faint}>{row === 0 ? "type to answer in your own words…" : ""}</Line>
          }>
            <Line flexShrink={0} truncate={false} fg={theme.text}>{line()}</Line>
            <Show when={row === layout().cursorRow}>
              <Line width={1} flexShrink={0} fg={theme.spark}>▌</Line>
            </Show>
          </Show>
        </Row>
      }</Index>
    </box>
  </Panel>;
}
