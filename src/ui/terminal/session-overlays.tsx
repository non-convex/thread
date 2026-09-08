import { createMemo, For, Show, type Accessor } from "solid-js";
import type { AskScreen, CommandPickerScreen, RewindScreen } from "../state.js";
import type { ComposerSuggestion } from "./completion.js";
import type { ThreadViewResources } from "./resources.js";
import { selectedWindow } from "./screens.js";
import { SpinnerText } from "./spinner.js";
import { bold, STATUS_ICONS } from "./theme.js";

export function ComposerSuggestions(props: {
  suggestions: readonly ComposerSuggestion[];
  selected: number;
  resources: ThreadViewResources;
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

export const COMMAND_OVERLAY_MAX_ITEMS = 6;

export function CommandPickerOverlay(props: {
  screen: Accessor<CommandPickerScreen>;
  selected: Accessor<number>;
  navigated: Accessor<boolean>;
  resources: ThreadViewResources;
  contentWidth: Accessor<number>;
}) {
  const theme = props.resources.theme;
  const rowWidth = () => props.contentWidth() - 2;
  const visible = createMemo(() => selectedWindow(props.screen().items, props.selected(), COMMAND_OVERLAY_MAX_ITEMS));
  return (
    <box flexDirection="column" width={props.contentWidth()} paddingX={1}>
      <box flexDirection="row" width={rowWidth()} height={1} marginBottom={1}>
        <text flexGrow={1} flexShrink={1} height={1} wrapMode="none" truncate={true} fg={theme.accent} attributes={bold}>
          {props.screen().title}
        </text>
        <text height={1} wrapMode="none" fg={theme.faint}>
          {props.screen().items[props.selected()]?.submit === false ? "↑/↓ · ⏎ edit · esc" : "↑/↓ · ⏎ select · esc"}
        </text>
      </box>
      <For each={visible()}>
        {({ item, index }) => (
          <box flexDirection="column" width={rowWidth()} height={2} backgroundColor={index === props.selected() ? theme.surfaceHigh : "transparent"}>
            <text width={rowWidth()} height={1} wrapMode="none" truncate={true} fg={index === props.selected() ? theme.sparkAlt : theme.text} attributes={index === props.selected() ? bold : 0}>
              {index === props.selected() ? `${STATUS_ICONS.selected} ` : "  "}{item.current ? `${STATUS_ICONS.current} ` : ""}{item.label}
            </text>
            <text width={rowWidth()} height={1} wrapMode="none" truncate={true} fg={theme.muted}>  {item.description}</text>
          </box>
        )}
      </For>
      <Show when={props.screen().items.length === 0}>
        <text width={rowWidth()} height={1} wrapMode="none" truncate={true} fg={theme.muted}>
          {props.screen().emptyText ?? "No options available."}
        </text>
      </Show>
      <Show when={props.screen().busy}>
        <text width={rowWidth()} height={1} fg={theme.spark}>opening…</text>
      </Show>
      <Show when={props.screen().error !== undefined && !props.navigated()}>
        <text width={rowWidth()} height={1} wrapMode="none" truncate={true} fg={theme.error}>{props.screen().error}</text>
      </Show>
    </box>
  );
}

export const REWIND_OVERLAY_MAX_ROWS = 8;

function rewindTime(startedAt: number): string {
  const date = new Date(startedAt);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function RewindOverlay(props: {
  screen: Accessor<RewindScreen>;
  selected: Accessor<number>;
  navigated: Accessor<boolean>;
  resources: ThreadViewResources;
  contentWidth: Accessor<number>;
}) {
  const theme = () => props.resources.theme;
  const visible = createMemo(() =>
    selectedWindow(props.screen().items, props.selected(), REWIND_OVERLAY_MAX_ROWS));
  const selectedItem = () => props.screen().items[props.selected()];
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
      <Show when={props.screen().confirm && !props.navigated() && selectedItem() !== undefined}>
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

export const ASK_OVERLAY_MAX_OPTIONS = 4;

export function AskOverlay(props: {
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
