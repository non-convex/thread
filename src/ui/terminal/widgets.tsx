import type { JSX } from "@opentui/solid";
import { Show } from "solid-js";
import type { ThreadViewResources } from "./resources.js";
import { SpinnerText } from "./spinner.js";
import { bold, STATUS_ICONS } from "./theme.js";

/** Single terminal rows share clipping rules; multiline transcript text does not. */
export function Line(props: JSX.IntrinsicElements["text"]) {
  return <text height={1} wrapMode="none" truncate={true} {...props} />;
}
export function Row(props: JSX.IntrinsicElements["box"]) {
  return <box flexDirection="row" height={1} {...props} />;
}

// Wider than any realistic terminal; the parent clips the rest.
const RULE_TEXT = "─".repeat(512);

/** Stretchable horizontal rule segment; labelled rules place text between segments. */
export function RuleFill(props: { color: string; width?: number; grow?: boolean; minWidth?: number }) {
  return <box height={1} overflow="hidden" flexShrink={props.width === undefined ? 1 : 0}
    {...(props.width === undefined ? { flexBasis: 0, flexGrow: props.grow === false ? 0 : 1, minWidth: props.minWidth ?? 1 }
      : { width: props.width })}>
    <text height={1} wrapMode="none" selectable={false} fg={props.color}>{RULE_TEXT}</text>
  </box>;
}

/** Floating panels open with a titled rule that sits directly above the composer rule. */
export function Panel(props: {
  width: number;
  resources: ThreadViewResources;
  title: string;
  hint: string;
  icon?: string;
  titleColor?: string;
  ruleColor?: string;
  busy?: string | undefined;
  error?: string | undefined;
  spinner?: boolean;
  children: JSX.Element;
}) {
  const theme = props.resources.theme;
  const rule = () => props.ruleColor ?? theme.borderStrong;
  return <box flexDirection="column" width={props.width} paddingX={1}>
    <Row width={props.width - 2} marginBottom={1}>
      <RuleFill width={2} color={rule()} />
      <Show when={props.icon}><Line flexShrink={0} fg={theme.accent}> {props.icon}</Line></Show>
      <Line flexShrink={1} minWidth={0} fg={props.titleColor ?? theme.accent} attributes={bold}> {props.title} </Line>
      <RuleFill color={rule()} />
      <Line flexShrink={0} fg={theme.faint} truncate={false}> {props.hint} </Line>
      <RuleFill width={2} color={rule()} />
    </Row>
    {props.children}
    <Show when={props.busy}>
      <Row width={props.width - 2}>
        <Show when={props.spinner !== false}><SpinnerText fg={theme.spark} /></Show>
        <Line fg={theme.spark}>{props.spinner !== false ? " " : ""}{props.busy}</Line>
      </Row>
    </Show>
    <Show when={props.error !== undefined}>
      <Line width={props.width - 2} fg={theme.error}>{props.error}</Line>
    </Show>
  </box>;
}

export function ChoiceRow(props: {
  resources: ThreadViewResources;
  width: number;
  selected: boolean;
  current?: boolean;
  label: string;
  labelWidth: number;
  detail: string;
  detailWidth?: number;
  gap?: number;
  highlightCurrent?: boolean;
}) {
  const theme = props.resources.theme;
  return <Row width={props.width} paddingX={1} backgroundColor={props.selected ? theme.surfaceHigh : "transparent"}>
    <Line width={2} fg={props.selected ? theme.sparkAlt : props.current ? theme.accent : theme.muted}>
      {props.selected ? `${STATUS_ICONS.selected} ` : props.current ? `${STATUS_ICONS.current} ` : "  "}
    </Line>
    <Line width={props.labelWidth} flexShrink={1} attributes={props.selected || props.current ? bold : 0}
      fg={props.selected ? theme.sparkAlt : props.current && props.highlightCurrent ? theme.accent : theme.text}>{props.label}</Line>
    <Show when={props.gap}><Line width={props.gap ?? 0}>  </Line></Show>
    <Line width={props.detailWidth ?? "auto"} flexGrow={props.detailWidth === undefined ? 1 : 0} flexShrink={1}
      fg={props.selected ? theme.softText : theme.muted}>{props.detail}</Line>
  </Row>;
}
