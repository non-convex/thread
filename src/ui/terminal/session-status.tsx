import { createMemo, Show, type Accessor } from "solid-js";
import stringWidth from "string-width";
import { statusLineParts, turnChangeCounts, type UiState } from "../state.js";
import type { TerminalMeta } from "./view-model.js";
import type { ThreadViewResources } from "./resources.js";
import { SpinnerText, tuiAnimationTime } from "./spinner.js";
import { contextMeter, contextMeterColor, formatTokenCount } from "./theme.js";

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

const FOOTER_SEPARATOR = "  │  ";
const SESSION_MIN_COLUMNS = 16;
const BRANCH_MIN_COLUMNS = 6;
// The branch adds a separator and its ⎇ mark.
const BRANCH_FIXED_COLUMNS = stringWidth(FOOTER_SEPARATOR) + 1;

/**
 * Whole-column widths for the two variable labels. The branch gives way first,
 * then the session id down to its minimum; the branch disappears before the id
 * shrinks further. Proportional shrinking splits columns into fractions, and
 * rounded-up text widths then overlap their neighbours.
 */
function footerLabelWidths(input: {
  width: number; sessionId: string; branch: string | undefined; fixed: number;
}): { session: number; branch: number } {
  const session = stringWidth(` ${input.sessionId}`);
  const branch = input.branch ? stringWidth(` ${input.branch}`) : 0;
  const withBranch = input.width - input.fixed - (input.branch ? BRANCH_FIXED_COLUMNS : 0);
  if (!input.branch || withBranch < SESSION_MIN_COLUMNS + BRANCH_MIN_COLUMNS) {
    return { session: Math.max(1, Math.min(session, input.width - input.fixed)), branch: 0 };
  }
  const branchWidth = Math.min(branch, Math.max(BRANCH_MIN_COLUMNS, withBranch - session));
  return { session: Math.min(session, withBranch - branchWidth), branch: branchWidth };
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
  const cacheText = () => ` ⚡ ${cacheHitLabel(meta().cacheHitPercent)}`;
  const missText = () => cacheMissHint(meta().cacheMissReason, meta().cacheMissedTokens);
  const labels = createMemo(() => {
    const thinking = meta().supportsThinking ? stringWidth(` · ${meta().thinkingLevel}`) + (narrow() ? 0 : 3) : 0;
    // Padding, the ⊙ mark and the two-cell minimum spacer before the model.
    const fixed = 5
      + (compact() ? 0 : stringWidth(FOOTER_SEPARATOR) + 8 + stringWidth(` ${meta().contextPercent}%`))
      + (narrow() ? 0 : stringWidth(cacheText() + missText()))
      + stringWidth(meta().modelName) + thinking;
    return footerLabelWidths({ width: props.width(), sessionId: state().sessionId, branch: meta().gitBranch, fixed });
  });

  return (
    <box flexDirection="row" width="100%" height={1} paddingX={1} backgroundColor={theme().surface}>
      <text height={1} wrapMode="none" flexShrink={0} fg={theme().faint}>⊙</text>
      <text width={labels().session} height={1} flexShrink={0} wrapMode="none" truncate={true} fg={theme().softText}>
        {" "}{state().sessionId}
      </text>
      <Show when={labels().branch > 0}>
        <text height={1} wrapMode="none" flexShrink={0} fg={theme().border}>{FOOTER_SEPARATOR}</text>
        <text height={1} wrapMode="none" flexShrink={0} fg={theme().accent}>⎇</text>
        <text width={labels().branch} height={1} flexShrink={0} wrapMode="none" truncate={true} fg={theme().softText}>
          {" "}{meta().gitBranch}
        </text>
      </Show>
      <Show when={!compact()}>
        <text height={1} wrapMode="none" flexShrink={0} fg={theme().border}>{FOOTER_SEPARATOR}</text>
        <text height={1} wrapMode="none" flexShrink={0} fg={meterColor()}>{contextMeter(meta().contextPercent, 8)}</text>
        <text height={1} wrapMode="none" flexShrink={0} fg={theme().muted}> {meta().contextPercent}%</text>
      </Show>
      <Show when={!narrow()}>
        <text height={1} wrapMode="none" flexShrink={0} fg={theme().faint}>{cacheText()}</text>
        <Show when={missText()}>
          <text height={1} wrapMode="none" flexShrink={0} fg={theme().warning}>{missText()}</text>
        </Show>
      </Show>

      <box flexGrow={1} minWidth={2} />
      <text height={1} wrapMode="none" flexShrink={0} fg={theme().nameAccent}>{meta().modelName}</text>
      <Show when={meta().supportsThinking}>
        <text height={1} wrapMode="none" flexShrink={0} fg={theme().muted}> · {meta().thinkingLevel}</text>
        <Show when={!narrow()}>
          <text height={1} wrapMode="none" flexShrink={0} fg={theme().faint}> ⇧⇥</text>
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
  const changes = createMemo(() => turnChangeCounts(state()));
  const hasChanges = () => changes().additions > 0 || changes().deletions > 0;
  const noticeLevel = () => state().notice?.level;
  const color = () => state().busy
    ? theme().runningAccent
    : noticeLevel() === "error"
      ? theme().error
      : noticeLevel() === "success"
        ? theme().success
        : theme().muted;
  return (
    <box flexDirection="row" width="100%" height={1} paddingX={1}>
      <box flexDirection="row" flexBasis={0} flexGrow={1} minWidth={0} height={1} overflow="hidden">
        <Show when={state().busy}>
          <SpinnerText fg={theme().runningAccent} />
          <text width={1} height={1}> </text>
        </Show>
        <text flexShrink={1} minWidth={0} height={1} wrapMode="none" fg={color()} truncate={true}>
          {parts().main}
        </text>
        <Show when={parts().elapsed}>
          <text marginLeft={2} height={1} flexShrink={0} wrapMode="none" fg={theme().faint}>{parts().elapsed}</text>
        </Show>
      </box>
      <Show when={hasChanges()}>
        <box id="turn-change-counts" flexDirection="row" flexShrink={0} height={1} marginX={1}>
          <text height={1} wrapMode="none" fg={theme().diffAdded}>+{changes().additions}</text>
          <text width={1} height={1}> </text>
          <text height={1} wrapMode="none" fg={theme().diffRemoved}>−{changes().deletions}</text>
        </box>
      </Show>
      {/* Equal side widths keep the counts centred regardless of status text length. */}
      <box flexDirection="row" flexBasis={hasChanges() ? 0 : "auto"} flexGrow={hasChanges() ? 1 : 0}
        minWidth={0} height={1} justifyContent="flex-end" overflow="hidden">
        <Show when={state().busy}>
          <text height={1} flexShrink={1} minWidth={0} wrapMode="none" truncate={true} fg={theme().faint}>esc interrupt</text>
        </Show>
      </box>
    </box>
  );
}
