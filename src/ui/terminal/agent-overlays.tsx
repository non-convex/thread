import { createMemo, For, Show, type Accessor } from "solid-js";
import { filteredModels, type AgentPickerScreen, type AgentSettingsScreen, type ModelPickerScreen } from "../state.js";
import type { ThreadViewResources } from "./resources.js";
import { modelDetail, selectedWindow } from "./screens.js";
import { SpinnerText } from "./spinner.js";
import { bold, STATUS_ICONS } from "./theme.js";

export const MODEL_OVERLAY_MAX_ROWS = 8;

export function ModelPickerOverlay(props: {
  screen: Accessor<ModelPickerScreen>;
  selected: Accessor<number>;
  navigated: Accessor<boolean>;
  resources: ThreadViewResources;
  contentWidth: Accessor<number>;
}) {
  const theme = () => props.resources.theme;
  const models = createMemo(() => filteredModels(props.screen()));
  const visible = createMemo(() =>
    selectedWindow(models(), props.selected(), MODEL_OVERLAY_MAX_ROWS));
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
      <text width={rowWidth()} height={1} wrapMode="none" truncate={true} fg={theme().muted}>
        Filter: {props.screen().filter || "type a provider or model name"}
      </text>
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
      <Show when={models().length === 0}>
        <text width={rowWidth()} height={1} fg={theme().muted}>No matching models. Edit the filter or change the model list.</text>
      </Show>
      <box width={rowWidth()} height={1} backgroundColor={props.selected() === models().length ? theme().surfaceHigh : "transparent"}>
        <text width={rowWidth()} height={1} wrapMode="none" truncate={true} fg={props.selected() === models().length ? theme().sparkAlt : theme().accent}>
          {props.selected() === models().length ? `${STATUS_ICONS.selected} ` : "  "}{props.screen().scope === "configured" ? "Browse all models" : "Show configured models"}
        </text>
      </box>
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

export function AgentPickerOverlay(props: {
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
        {/* Text presentation and a fixed slot avoid emoji-width overlap in terminals. */}
        <text width={3} flexShrink={0} height={1} wrapMode="none" fg={theme().accent}>{"\u2699\uFE0E"}</text>
        <text flexGrow={1} height={1} wrapMode="none" fg={theme().accent} attributes={bold}>Agents</text>
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

export function AgentSettingsOverlay(props: {
  screen: Accessor<AgentSettingsScreen>;
  selected: Accessor<number>;
  resources: ThreadViewResources;
  contentWidth: Accessor<number>;
}) {
  const theme = () => props.resources.theme;
  const options = [
    { label: "Off", description: `Disable ${props.screen().label}` },
    { label: "On", description: "Use the last model, or choose one if none is set" },
    { label: "Choose model", description: `Select a model and enable ${props.screen().label}` },
  ] as const;
  return (
    <box flexDirection="column" width={props.contentWidth()} paddingX={1}>
      <box flexDirection="row" width={props.contentWidth() - 2} height={1} marginBottom={1}>
        <text width={3} flexShrink={0} height={1} wrapMode="none" fg={theme().accent}>{"\u2699\uFE0E"}</text>
        <text flexGrow={1} height={1} wrapMode="none" fg={theme().accent} attributes={bold}>{props.screen().label}</text>
        <text height={1} wrapMode="none" fg={theme().faint}>↑/↓ · ⏎ select · esc</text>
      </box>
      <For each={options}>
        {(option, index) => {
          const selected = () => index() === props.selected();
          const current = () => index() < 2 && props.screen().enabled === (index() === 1);
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
              <text width={14} height={1} wrapMode="none" fg={selected() ? theme().sparkAlt : theme().text} attributes={selected() || current() ? bold : 0}>
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
