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

export function Panel(props: {
  width: number;
  resources: ThreadViewResources;
  title: string;
  hint: string;
  icon?: string;
  titleWidth?: number;
  titleColor?: string;
  busy?: string | undefined;
  error?: string | undefined;
  spinner?: boolean;
  children: JSX.Element;
}) {
  const theme = props.resources.theme;
  return <box flexDirection="column" width={props.width} paddingX={1}>
    <Row width={props.width - 2} marginBottom={1}>
      <Show when={props.icon}><Line width={3} flexShrink={0} fg={theme.accent}>{props.icon}</Line></Show>
      <Line width={props.titleWidth ?? "auto"} flexGrow={props.titleWidth === undefined ? 1 : 0}
        flexShrink={1} fg={props.titleColor ?? theme.accent} attributes={bold}>{props.title}</Line>
      <Line fg={theme.faint} truncate={false}>{props.hint}</Line>
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
