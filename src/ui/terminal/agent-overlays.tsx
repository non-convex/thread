import { createMemo, For, Show, type Accessor } from "solid-js";
import { filteredModels, type AgentPickerScreen, type AgentSettingsScreen, type ModelPickerScreen } from "../state.js";
import type { ThreadViewResources } from "./resources.js";
import { modelDetail, selectedWindow } from "./screens.js";
import { STATUS_ICONS } from "./theme.js";
import { ChoiceRow, Line, Panel, Row } from "./widgets.js";

export const MODEL_OVERLAY_MAX_ROWS = 8;
export interface OverlayProps<T> {
  screen: Accessor<T>;
  selected: Accessor<number>;
  navigated: Accessor<boolean>;
  resources: ThreadViewResources;
  contentWidth: Accessor<number>;
}

export function ModelPickerOverlay(props: OverlayProps<ModelPickerScreen>) {
  const theme = props.resources.theme;
  const models = createMemo(() => filteredModels(props.screen()));
  const visible = createMemo(() => selectedWindow(models(), props.selected(), MODEL_OVERLAY_MAX_ROWS));
  const rowWidth = () => props.contentWidth() - 2;
  const identifierWidth = createMemo(() => Math.min(
    props.screen().models.reduce((length, model) => Math.max(length, `${model.providerId}/${model.modelId}`.length), 8),
    Math.max(8, Math.floor(rowWidth() * 0.45)), Math.max(8, rowWidth() - 8),
  ));
  const title = () => `${props.screen().agentId === "main" ? "Main" : props.screen().agentId === "dreamer" ? "Dreamer" : "Worker"} model${props.screen().scope === "all" ? " · all" : ""}`;
  return <Panel width={props.contentWidth()} resources={props.resources} title={title()}
    hint={props.screen().agentId === "main" ? "↑/↓ · ⏎ switch · esc" : "↑/↓ · ⏎ enable · esc"}
    busy={props.screen().busy ? (props.screen().agentId === "main" ? "switching model…" : "enabling agent…") : undefined}
    error={props.navigated() ? undefined : props.screen().error}>
    <Line width={rowWidth()} fg={theme.muted}>Filter: {props.screen().filter || "type a provider or model name"}</Line>
    <For each={visible()}>{({ item: model, index }) =>
      <ChoiceRow resources={props.resources} width={rowWidth()} selected={index === props.selected()}
        current={model.providerId === props.screen().currentProviderId && model.modelId === props.screen().currentModelId}
        highlightCurrent={true} label={`${model.providerId}/${model.modelId}`} labelWidth={identifierWidth()}
        detail={modelDetail(model)} detailWidth={Math.max(4, rowWidth() - identifierWidth() - 4)} gap={2} />
    }</For>
    <Show when={!models().length}>
      <Line width={rowWidth()} fg={theme.muted}>No matching models. Edit the filter or change the model list.</Line>
    </Show>
    <Row width={rowWidth()} backgroundColor={props.selected() === models().length ? theme.surfaceHigh : "transparent"}>
      <Line width={rowWidth()} fg={props.selected() === models().length ? theme.sparkAlt : theme.accent}>
        {props.selected() === models().length ? `${STATUS_ICONS.selected} ` : "  "}{props.screen().scope === "configured" ? "Browse all models" : "Show configured models"}
      </Line>
    </Row>
  </Panel>;
}

export function AgentPickerOverlay(props: OverlayProps<AgentPickerScreen>) {
  return <Panel width={props.contentWidth()} resources={props.resources} title="Agents" icon={"\u2699\uFE0E"}
    hint="↑/↓ · ⏎ configure · esc" busy={props.screen().busy ? "opening agent…" : undefined}
    error={props.navigated() ? undefined : props.screen().error}>
    <For each={props.screen().agents}>{(agent, index) =>
      <ChoiceRow resources={props.resources} width={props.contentWidth() - 2} selected={index() === props.selected()}
        current={agent.enabled} label={agent.label} labelWidth={24} detail={`${agent.enabled ? "on" : "off"} · ${agent.detail}`} />
    }</For>
  </Panel>;
}

export function AgentSettingsOverlay(props: Omit<OverlayProps<AgentSettingsScreen>, "navigated">) {
  const options = () => [
    { label: "Off", description: `Disable ${props.screen().label}` },
    { label: "On", description: "Use the last model, or choose one if none is set" },
    { label: "Choose model", description: `Select a model and enable ${props.screen().label}` },
  ];
  return <Panel width={props.contentWidth()} resources={props.resources} title={props.screen().label} icon={"\u2699\uFE0E"}
    hint="↑/↓ · ⏎ select · esc" busy={props.screen().busy ? "updating agent…" : undefined} error={props.screen().error}>
    <For each={options()}>{(option, index) =>
      <ChoiceRow resources={props.resources} width={props.contentWidth() - 2} selected={index() === props.selected()}
        current={index() < 2 && props.screen().enabled === (index() === 1)} label={option.label} labelWidth={14} detail={option.description} />
    }</For>
  </Panel>;
}
