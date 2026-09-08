import { createMemo, Show, type Accessor } from "solid-js";
import { statusLineParts, type UiState } from "../state.js";
import type { TerminalMeta } from "./view-model.js";
import type { ThreadViewResources } from "./resources.js";
import { SpinnerText, tuiAnimationTime } from "./spinner.js";
import { bold, contextMeter, contextMeterColor, formatTokenCount } from "./theme.js";

function cacheHitLabel(percent: number | null): string {
  return percent === null ? "cache —" : `cache ${percent}%`;
}

function cacheMissHint(
  reason: "idle" | "model-changed" | "prefix-changed" | null,
  missedTokens: number,
): string {
  if (!reason || missedTokens <= 0) return "";
  const labels = { idle: "idle", "model-changed": "model", "prefix-changed": "prefix" } as const;
  return ` ↓${formatTokenCount(missedTokens)} ${labels[reason]}`;
}

export function Footer(props: {
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
      <text height={1} wrapMode="none" fg={theme().faint}>⊙</text>
      <text
        height={1}
        wrapMode="none"
        truncate={true}
        flexShrink={2}
        minWidth={16}
        fg={theme().softText}
      > {state().sessionId}</text>
      <Show when={meta().gitBranch}>
        <text height={1} wrapMode="none" fg={theme().border}>  │  </text>
        <text height={1} wrapMode="none" fg={theme().accent}>⎇</text>
        <text height={1} wrapMode="none" truncate={true} flexShrink={3} fg={theme().softText}> {meta().gitBranch}</text>
      </Show>
      <Show when={!compact()}>
        <text height={1} wrapMode="none" fg={theme().border}>  │  </text>
        <text height={1} wrapMode="none" fg={meterColor()}>{contextMeter(meta().contextPercent, 8)}</text>
        <text height={1} wrapMode="none" fg={theme().muted}> {meta().contextPercent}%</text>
      </Show>
      <Show when={!narrow()}>
        <text height={1} wrapMode="none" fg={theme().faint}> ⚡ {cacheHitLabel(meta().cacheHitPercent)}</text>
        <Show when={cacheMissHint(meta().cacheMissReason, meta().cacheMissedTokens)}>
          <text height={1} wrapMode="none" fg={theme().warning}>
            {cacheMissHint(meta().cacheMissReason, meta().cacheMissedTokens)}
          </text>
        </Show>
      </Show>

      <box flexGrow={1} minWidth={1} />
      <text height={1} wrapMode="none" flexShrink={0} fg={theme().accent} attributes={bold}>{meta().modelName}</text>
      <Show when={meta().supportsThinking}>
        <text height={1} wrapMode="none" fg={theme().muted}> · {meta().thinkingLevel}</text>
        <Show when={!narrow()}>
          <text height={1} wrapMode="none" fg={theme().faint}> ⇧⇥</text>
        </Show>
      </Show>
    </box>
  );
}

export function Status(props: { state: Accessor<UiState>; resources: ThreadViewResources }) {
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
