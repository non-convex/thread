import { MouseButton, type ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
import stringWidth from "string-width";
import { formatDurationMs, type AgentTaskCard } from "../state.js";
import type { CopyText } from "./clipboard.js";
import type { ThreadViewResources } from "./resources.js";
import { createSpinnerFrame } from "./spinner.js";
import { bold, formatTokenCount, STATUS_ICONS } from "./theme.js";
import { cleanToolText, toolArguments } from "./tool-presentation.js";
import { createTranscriptExpansion } from "./transcript-expansion.js";
import { AgentTaskDetailsView } from "./transcript.js";
import { Line, Panel } from "./widgets.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const compactWidth = 72;

/** Keep each card row within its terminal-cell budget, including wide graphemes. */
function fitLabel(text: string, width: number): string {
  const value = cleanToolText(text).replace(/\s+/g, " ").trim();
  if (width < 1) return "";
  if (stringWidth(value) <= width) return value;
  let result = "";
  let used = 0;
  for (const { segment } of graphemes.segment(value)) {
    const cells = stringWidth(segment);
    if (used + cells > width - 1) break;
    result += segment;
    used += cells;
  }
  return `${result}…`;
}

function firstLine(text: string): string {
  return cleanToolText(text).split("\n").find((line) => line.trim())?.trim() ?? "";
}

function cardCurrentAction(card: AgentTaskCard): {
  text: string; tone: "error" | "muted" | "text" | "tool" | "thinking"; toolName?: string;
} {
  if (card.summary.status === "failed") return { text: firstLine(card.summary.error ?? "") || "failed", tone: "error" };
  if (card.summary.status === "cancelled") return { text: "cancelled", tone: "muted" };
  if (card.summary.status === "completed") {
    const reply = card.trace.findLast((block) => block.kind === "assistant" && block.content.trim());
    return { text: reply ? firstLine(reply.content) : "completed", tone: "text" };
  }
  const latest = card.trace.findLast((block) => block.tool?.status === "running" || block.tool?.status === "queued")
    ?? card.trace.at(-1);
  if (latest?.tool) return { text: `${latest.tool.name} ${toolArguments(latest.tool)}`, tone: "tool", toolName: latest.tool.name };
  if (latest?.kind === "thinking") return { text: "thinking", tone: "thinking" };
  if (latest?.kind === "assistant") return { text: firstLine(latest.content) || "responding", tone: "text" };
  return { text: "starting…", tone: "muted" };
}

function statusIcon(status: AgentTaskCard["summary"]["status"]): string {
  return status === "completed" ? STATUS_ICONS.success : status === "failed" ? STATUS_ICONS.error
    : status === "running" ? STATUS_ICONS.running : "−";
}

export function workerCardsHeight(count: number, terminalWidth: number): number {
  // Include one empty row between the cards and Main's status line.
  return count ? (terminalWidth < compactWidth ? 1 : 3) + 1 : 0;
}

function WorkerCard(props: {
  card: Accessor<AgentTaskCard>; resources: ThreadViewResources; width: number;
  compact: boolean; selected: boolean; onClick: () => void;
}) {
  const renderer = useRenderer();
  let pressedAt: { x: number; y: number } | undefined;
  const theme = props.resources.theme;
  const summary = () => props.card().summary;
  const running = () => summary().status === "running";
  const frame = createSpinnerFrame(running);
  const icon = () => running() ? frame() : statusIcon(summary().status);
  const color = () => running() ? theme.spark : summary().status === "failed" ? theme.error
    : summary().status === "completed" ? theme.success : theme.muted;
  const border = () => props.selected ? theme.accent : summary().status === "failed" ? theme.error : theme.borderStrong;
  const action = createMemo(() => cardCurrentAction(props.card()));
  const title = () => fitLabel(summary().title, props.width - 7);
  const actionText = () => fitLabel(action().text, props.width - 4);
  const toolName = () => fitLabel(action().toolName ?? "", props.width - 4);
  const actionColor = () => ({ error: theme.error, muted: theme.muted, text: theme.softText,
    tool: theme.toolCallText, thinking: theme.thinking }[action().tone]);
  const compactLabel = () => {
    const elapsed = formatDurationMs(summary().elapsedMs);
    const title = fitLabel(summary().title, props.width - stringWidth(elapsed) - 5);
    return fitLabel(`${icon()} ${title} · ${elapsed}`, props.width);
  };
  const metadata = createMemo(() => {
    const stats = [
      ...(summary().revision > 1 ? [{ text: `r${summary().revision}`, color: theme.muted }] : []),
      { text: formatDurationMs(summary().elapsedMs), color: theme.softText },
      { text: formatTokenCount(summary().usage?.totalTokens ?? 0), color: theme.accentDim },
    ];
    let remaining = Math.max(0, props.width - 4);
    const model = fitLabel(summary().modelId, remaining - stringWidth(stats.map((part) => part.text).join(" · ")) - 3);
    const parts = model ? [{ text: model, color: theme.nameAccent }, ...stats] : stats;
    const visible: { text: string; color: string }[] = [];
    for (const part of parts) {
      if (remaining < 1) break;
      if (visible.length) {
        if (remaining <= 3) { visible.push({ text: "…", color: theme.faint }); break; }
        visible.push({ text: " · ", color: theme.faint });
        remaining -= 3;
      }
      const text = fitLabel(part.text, remaining);
      visible.push({ text, color: part.color });
      remaining -= stringWidth(text);
    }
    return visible;
  });
  const metadataWidth = () => metadata().reduce((width, part) => width + stringWidth(part.text), 0);
  // Native top/bottom titles share one colour; inline spans keep this three-row frame independently styled.
  return <box width={props.width} height={props.compact ? 1 : 3} flexDirection="column" flexShrink={0} overflow="hidden"
    backgroundColor={props.selected ? theme.surfaceHigh : theme.surface}
    onMouseDown={(event) => {
      pressedAt = event.button === MouseButton.LEFT ? { x: event.x, y: event.y } : undefined;
    }}
    onMouseDrag={() => { pressedAt = undefined; }}
    onMouseUp={(event) => {
      // OpenTUI marks even a stationary text click as isDragging while its selection is active.
      const clicked = pressedAt?.x === event.x && pressedAt?.y === event.y;
      pressedAt = undefined;
      if (event.button !== MouseButton.LEFT || !clicked || renderer.getSelection()?.getSelectedText()) return;
      event.stopPropagation();
      props.onClick();
    }}>
    <Show when={props.compact} fallback={
      <>
        <Line width="100%" flexShrink={0}>
          <span style={{ fg: border() }}>╭─</span><span style={{ fg: color() }}>{icon()}</span>
          <span style={{ fg: theme.accentStrong, attributes: bold }}> {title()} </span>
          <span style={{ fg: border() }}>{"─".repeat(Math.max(0, props.width - stringWidth(title()) - 6))}╮</span>
        </Line>
        <Line width="100%" flexShrink={0} fg={actionColor()}>
          <span style={{ fg: border() }}>│ </span>
          <span style={{ fg: theme.toolNameAccent }}>{toolName()}</span>{actionText().slice(toolName().length)}
          {" ".repeat(Math.max(0, props.width - 4 - stringWidth(actionText())))}<span style={{ fg: border() }}> │</span>
        </Line>
        <Line width="100%" flexShrink={0}>
          <span style={{ fg: border() }}>╰{"─".repeat(Math.max(0, props.width - metadataWidth() - 4))}</span>{" "}
          <For each={metadata()}>{(part) => <span style={{ fg: part.color }}>{part.text}</span>}</For>
          <span style={{ fg: border() }}> ╯</span>
        </Line>
      </>
    }>
      <Line width="100%" fg={color()}>
        {compactLabel()}
      </Line>
    </Show>
  </box>;
}

/** Only this row takes space from the transcript; the trace panel floats above it. */
export function WorkerCardsBar(props: {
  cards: readonly AgentTaskCard[]; resources: ThreadViewResources; terminalWidth: number;
  openedTaskId: string | undefined; onOpenTask: (taskId: string) => void;
}) {
  const renderer = useRenderer();
  const [page, setPage] = createSignal(0);
  const compact = () => props.terminalWidth < compactWidth;
  const width = () => Math.max(1, props.terminalWidth - 2);
  const byId = createMemo(() => new Map(props.cards.map((card) => [card.summary.taskId, card])));
  const layout = createMemo(() => {
    const minimum = compact() ? 20 : 26;
    const capacity = Math.max(1, Math.floor((width() + 1) / (minimum + 1)));
    const overflow = props.cards.length > capacity;
    const moreWidth = overflow ? Math.min(8, Math.max(1, width() - 4)) : 0;
    const count = Math.min(props.cards.length, Math.max(1, Math.floor((width() - moreWidth + 1) / (minimum + 1))));
    const pages = Math.max(1, Math.ceil(props.cards.length / Math.max(1, count)));
    const start = Math.min(page(), pages - 1) * count;
    return {
      count, pages, start, moreWidth,
      cardWidth: Math.max(1, Math.min(44, Math.floor((width() - moreWidth - Math.max(0, count - 1)) / Math.max(1, count)))),
    };
  });
  // Key by task ID, not the immutable card objects replaced on every streaming event.
  const visibleIds = createMemo(() => [...byId().keys()].slice(layout().start, layout().start + layout().count));
  return <box marginX={1} width={width()} height={workerCardsHeight(props.cards.length, props.terminalWidth)}
    paddingBottom={1} flexDirection="row" flexShrink={0} overflow="hidden"
    onMouseDown={(event) => event.stopPropagation()}>
    <For each={visibleIds()}>{(id, index) =>
      <box marginRight={index() < visibleIds().length - 1 ? 1 : 0} flexShrink={0}>
        <WorkerCard card={() => byId().get(id)!} resources={props.resources} width={layout().cardWidth}
          compact={compact()} selected={props.openedTaskId === id} onClick={() => props.onOpenTask(id)} />
      </box>
    }</For>
    <Show when={layout().moreWidth > 0}>
      <box width={layout().moreWidth} height={compact() ? 1 : 3} flexShrink={0} justifyContent="center"
        onMouseUp={(event) => {
          if (event.button !== MouseButton.LEFT || event.isDragging || renderer.getSelection()?.getSelectedText()) return;
          event.stopPropagation();
          setPage((Math.min(page(), layout().pages - 1) + 1) % layout().pages);
        }}>
        <Line width="100%" fg={props.resources.theme.accent} selectable={false}>
          +{props.cards.length - visibleIds().length} ›
        </Line>
      </box>
    </Show>
  </box>;
}

export function WorkerTraceOverlay(props: {
  card: Accessor<AgentTaskCard>; resources: ThreadViewResources; copyText: CopyText;
  width: number; height: number; setScroll: (value: ScrollBoxRenderable | undefined) => void;
}) {
  const expansions = createTranscriptExpansion();
  const summary = () => props.card().summary;
  const theme = props.resources.theme;
  return <box width={props.width} height={props.height} overflow="hidden" backgroundColor={theme.surface}
    onMouseDown={(event) => event.stopPropagation()}>
    <Panel width={props.width} resources={props.resources}
      title={`${statusIcon(summary().status)} ${summary().title}`} hint="PgUp/PgDn · esc close"
      ruleColor={summary().status === "running" ? theme.spark : theme.borderStrong}>
      <Line width={Math.max(1, props.width - 2)} fg={theme.muted}>
        {summary().status} · r{summary().revision} · {formatDurationMs(summary().elapsedMs)} · ctx {summary().contextTokens} · usage {summary().usage?.totalTokens ?? 0}
      </Line>
      <AgentTaskDetailsView card={props.card} resources={props.resources} copyText={props.copyText}
        expansions={expansions} height={Math.max(2, props.height - 3)} setScroll={props.setScroll} />
    </Panel>
  </box>;
}
