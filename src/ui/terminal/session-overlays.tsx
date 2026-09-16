import { createMemo, For, Match, Show, Switch, type Accessor } from "solid-js";
import { filteredModels, type AgentPickerScreen, type AgentSettingsScreen, type AskScreen, type CommandPickerScreen, type ModelPickerScreen, type RewindScreen, type UiScreen } from "../state.js";
import type { ComposerSuggestion } from "./completion.js";
import type { ThreadViewResources } from "./resources.js";
import { AgentPickerOverlay, AgentSettingsOverlay, ModelPickerOverlay, MODEL_OVERLAY_MAX_ROWS, type OverlayProps } from "./agent-overlays.js";
import { selectedWindow } from "./screens.js";
import { bold, STATUS_ICONS } from "./theme.js";
import { Line, Panel, Row } from "./widgets.js";

export const COMMAND_OVERLAY_MAX_ITEMS = 6;
export const REWIND_OVERLAY_MAX_ROWS = 8;
export const ASK_OVERLAY_MAX_OPTIONS = 4;

/** Header, body, optional status lines and border share one sizing rule. */
export function overlayHeight(screen: UiScreen): number {
  let rows: number;
  switch (screen.type) {
    case "command_picker": rows = Math.max(1, Math.min(COMMAND_OVERLAY_MAX_ITEMS, screen.items.length) * 2); break;
    case "model_picker": rows = 2 + Math.max(1, Math.min(MODEL_OVERLAY_MAX_ROWS, filteredModels(screen).length)); break;
    case "agent_picker": rows = screen.agents.length; break;
    case "agent_settings": rows = 3; break;
    case "rewind": rows = Math.min(REWIND_OVERLAY_MAX_ROWS, screen.items.length) + Number(screen.confirm); break;
    case "ask": return 4 + (screen.customText !== undefined ? 1
      : Math.min(ASK_OVERLAY_MAX_OPTIONS, screen.request.questions[screen.questionIndex]?.options.length ?? 0) + 1);
    default: return 0;
  }
  return 4 + rows + Number(screen.busy) + Number(Boolean(screen.error));
}

export function SessionOverlay(props: OverlayProps<UiScreen>) {
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
      <AskOverlay {...props} screen={() => props.screen() as AskScreen} />
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
    <For each={props.suggestions}>{(suggestion, index) =>
      <Row width={props.contentWidth() - 2} backgroundColor={index() === props.selected ? theme.surfaceHigh : "transparent"}>
        <Line width={14} fg={index() === props.selected ? theme.sparkAlt : theme.text} attributes={index() === props.selected ? bold : 0}>
          {index() === props.selected ? `${STATUS_ICONS.selected} ` : ""}{suggestion.label}
        </Line>
        <Line width={Math.max(4, props.contentWidth() - 16)} flexShrink={1} fg={index() === props.selected ? theme.softText : theme.muted}>
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
    titleWidth={Math.max(8, props.contentWidth() - 23)} hint="↑/↓ · ⏎ select · esc"
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

export function AskOverlay(props: Pick<OverlayProps<AskScreen>, "screen" | "resources" | "contentWidth">) {
  const theme = props.resources.theme;
  const question = () => props.screen().request.questions[props.screen().questionIndex];
  const total = () => props.screen().request.questions.length;
  const chosen = () => props.screen().chosen[props.screen().questionIndex] ?? [];
  const typing = () => props.screen().customText !== undefined;
  const title = () => `${STATUS_ICONS.info} ${question()?.header ?? "question"}${total() > 1 ? `  ${props.screen().questionIndex + 1}/${total()}` : ""}`;
  return <Panel width={props.contentWidth()} resources={props.resources} title={title()} titleColor={theme.spark}
    titleWidth={Math.max(8, props.contentWidth() - 26)}
    hint={typing() ? "⏎ submit · esc back" : question()?.multiple ? "space mark · ⏎ ok" : "↑/↓ · ⏎ ok · esc"}>
    <Line width={props.contentWidth() - 2} fg={theme.text}>{question()?.question ?? ""}</Line>
    <Show when={!typing()}>
      <For each={question()?.options ?? []}>{(option, index) =>
        <Row width={props.contentWidth() - 2} paddingX={1} backgroundColor={index() === props.screen().selected ? theme.surfaceHigh : "transparent"}>
          <Line width={2} fg={theme.sparkAlt}>{index() === props.screen().selected ? `${STATUS_ICONS.selected} ` : "  "}</Line>
          <Line width={2} fg={theme.sparkAlt}>{question()?.multiple ? (chosen().includes(index()) ? "◉ " : "○ ") : ""}</Line>
          <Line width={Math.max(4, Math.floor((props.contentWidth() - 8) * 0.4))} flexShrink={0}
            fg={index() === props.screen().selected ? theme.text : theme.softText} attributes={index() === props.screen().selected ? bold : 0}>
            {option.label}
          </Line>
          <Line flexGrow={1} flexShrink={1} fg={theme.faint}>{option.description ? ` ${option.description}` : ""}</Line>
        </Row>
      }</For>
      <Line width={props.contentWidth() - 2} fg={theme.faint}>type to answer in your own words</Line>
    </Show>
    <Show when={typing()}>
      <Row width={props.contentWidth() - 2}>
        <Line width={2} fg={theme.spark}>› </Line>
        <Line flexGrow={1} flexShrink={1} fg={theme.text}>{props.screen().customText}</Line>
        <Line width={1} fg={theme.spark}>▌</Line>
      </Row>
    </Show>
  </Panel>;
}
