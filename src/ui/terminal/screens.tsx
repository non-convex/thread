import type { ScrollBoxRenderable } from "@opentui/core";
import type { Accessor } from "solid-js";
import type { ModelDescriptor } from "../../core/agent/model-catalog.js";
import type { UiScreen, UiState } from "../state.js";
import type { ThreadViewResources } from "./resources.js";
import { wheelScrollAcceleration } from "./scroll.js";
import { normalizeMarkdownForTerminal } from "./transcript-content.js";
import { bold } from "./theme.js";
import { RuleFill } from "./widgets.js";

export function selectedWindow<T>(items: readonly T[], selected: number, visible: number): Array<{ item: T; index: number }> {
  const count = Math.min(visible, items.length);
  const start = Math.max(0, Math.min(selected - Math.floor(count / 2), items.length - count));
  return items.slice(start, start + count).map((item, offset) => ({ item, index: start + offset }));
}

function ScreenHeader(props: { left: string; right: string; resources: ThreadViewResources }) {
  const theme = props.resources.theme;
  return (
    <box flexDirection="row" width="100%" height={1} paddingX={1}>
      <RuleFill width={2} color={theme.borderStrong} />
      <text height={1} flexShrink={1} minWidth={0} wrapMode="none" fg={theme.accentStrong} attributes={bold} truncate={true}> {props.left} </text>
      <RuleFill color={theme.borderStrong} />
      <text height={1} flexShrink={0} wrapMode="none" fg={theme.muted}> {props.right} </text>
      <RuleFill width={2} color={theme.borderStrong} />
    </box>
  );
}

function ScreenFooter(props: { hint: string; state: Accessor<UiState>; resources: ThreadViewResources }) {
  const theme = props.resources.theme;
  return (
    <box flexDirection="row" width="100%" height={1} paddingX={1}>
      <RuleFill width={2} color={theme.borderStrong} />
      <text height={1} flexShrink={1} minWidth={0} wrapMode="none" truncate={true} fg={theme.faint}> {props.hint} </text>
      <RuleFill color={theme.borderStrong} />
      <text height={1} flexShrink={0} wrapMode="none" fg={theme.softText}>
        {" "}session {short(props.state().sessionId)} · tip {props.state().liveTipTurnId ? short(props.state().liveTipTurnId!) : "root"}{" "}
      </text>
      <RuleFill width={2} color={theme.borderStrong} />
    </box>
  );
}

export function modelDetail(model: ModelDescriptor): string {
  return [
    model.name !== model.modelId ? model.name : undefined,
    `${model.contextWindow.toLocaleString("en-US")} ctx`,
    model.acceptsImages ? "vision" : undefined,
    model.reasoning ? "reasoning" : undefined,
  ].filter((value): value is string => value !== undefined).join(" · ");
}

export function DocumentScreen(props: {
  screen: () => Extract<UiScreen, { type: "document" }>;
  state: Accessor<UiState>;
  resources: ThreadViewResources;
  setScroll: (value: ScrollBoxRenderable) => void;
}) {
  return (
    <>
      <ScreenHeader left={props.screen().title.toUpperCase()} right="ephemeral · not in session" resources={props.resources} />
      <scrollbox
        ref={props.setScroll}
        flexGrow={1}
        viewportCulling={true}
        scrollAcceleration={wheelScrollAcceleration}
        verticalScrollbarOptions={{ visible: false }}
        paddingX={2}
        paddingY={1}
      >
        <markdown
          content={normalizeMarkdownForTerminal(props.screen().content)}
          width="100%"
          syntaxStyle={props.resources.syntaxStyle}
          fg={props.resources.theme.text}
          conceal={true}
          internalBlockMode="top-level"
        />
      </scrollbox>
      <ScreenFooter hint="↑/↓ scroll · Ctrl+C / Alt+C copy selection · esc back" state={props.state} resources={props.resources} />
    </>
  );
}

function short(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}
