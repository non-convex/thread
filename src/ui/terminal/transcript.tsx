import { MouseButton, type ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createMemo, createSignal, Match, onCleanup, Show, Switch, type Accessor } from "solid-js";
import type { AgentTaskCard, LiveTurn, TranscriptItem } from "../state.js";
import { bold, dim, italic, STATUS_ICONS, TRANSCRIPT_MARKS } from "./theme.js";
import { groupTranscriptTurns, projectLiveUser } from "./transcript-projection.js";
import { normalizeMarkdownForTerminal, ReplyCopyButton, ThinkingView } from "./transcript-content.js";
import type { CopyText } from "./clipboard.js";
import { ToolOutputView } from "./tool-output.js";
import type { ThreadViewResources } from "./resources.js";
import { SpinnerText } from "./spinner.js";
import { createTranscriptExpansion, type TranscriptExpansion } from "./transcript-expansion.js";
import { TranscriptWindow } from "./transcript-window.js";
import { wheelScrollAcceleration } from "./scroll.js";

function elapsedLabel(startedAt: number | undefined, finishedAt: number | undefined): string | undefined {
  if (startedAt === undefined || finishedAt === undefined || finishedAt < startedAt) return undefined;
  return `${((finishedAt - startedAt) / 1000).toFixed(1)}s`;
}

function MarkdownReply(props: {
  id?: string;
  content: string;
  resources: ThreadViewResources;
}) {
  return (
    // OpenTUI 0.5.7 only paints markdown content in streaming mode.
    <markdown
      {...(props.id ? { id: props.id } : {})}
      content={normalizeMarkdownForTerminal(props.content)}
      width="100%"
      syntaxStyle={props.resources.syntaxStyle}
      fg={props.resources.theme.text}
      conceal={true}
      streaming={true}
      maxWidth={180}
    />
  );
}

function UserMessageCard(props: { item: TranscriptItem; resources: ThreadViewResources }) {
  const theme = props.resources.theme;
  // A full-width band: the only filled surface in the transcript, easy to find while scrolling.
  return (
    <box width="100%" flexDirection="row" marginBottom={1} paddingX={1} backgroundColor={theme.surface}>
      <text width={2} height={1} flexShrink={0} wrapMode="none" fg={theme.accentDim} attributes={bold}>{TRANSCRIPT_MARKS.user}</text>
      <box flexBasis={0} flexGrow={1} flexShrink={1} minWidth={1}>
        <text width="100%" fg={theme.text} wrapMode="word">{props.item.content}</text>
      </box>
    </box>
  );
}

function CompactionInfo(props: {
  content: string; detail?: string | undefined; resources: ThreadViewResources; expansion: TranscriptExpansion;
}) {
  const renderer = useRenderer();
  const expanded = props.expansion.expanded;
  const expandable = () => Boolean(props.detail?.trim());
  const theme = props.resources.theme;
  return (
    <box
      flexDirection="column"
      width="100%"
      marginBottom={1}
      onMouseUp={(event) => {
        if (event.button === MouseButton.LEFT && expandable() && !renderer.getSelection()?.getSelectedText()) {
          event.stopPropagation();
          props.expansion.toggle();
        }
      }}
    >
      <box flexDirection="row" width="100%" height={1}>
        <text width={2} height={1} wrapMode="none" fg={theme.faint}>{TRANSCRIPT_MARKS.note}</text>
        <text flexGrow={1} height={1} wrapMode="none" truncate={true} fg={theme.muted} attributes={dim}>
          {props.content}
        </text>
        <Show when={expandable()}>
          <text height={1} wrapMode="none" fg={theme.faint}> {expanded() ? STATUS_ICONS.expanded : STATUS_ICONS.collapsed}</text>
        </Show>
      </box>
      <Show when={expanded() && expandable()}>
        <box flexDirection="column" width="100%" paddingLeft={2} paddingTop={1}>
          <MarkdownReply content={props.detail!} resources={props.resources} />
        </box>
      </Show>
    </box>
  );
}

function taskStatus(summary: AgentTaskCard["summary"], theme: ThreadViewResources["theme"]): { icon: string; color: string } {
  if (summary.status === "running") return { icon: STATUS_ICONS.running, color: theme.spark };
  if (summary.status === "completed") return { icon: STATUS_ICONS.success, color: theme.success };
  if (summary.status === "failed") return { icon: STATUS_ICONS.error, color: theme.error };
  return { icon: "−", color: theme.muted };
}

type ExpansionStore = ReturnType<typeof createTranscriptExpansion>;

/** The same task input and trace are available from the dock and historical task rows. */
export function AgentTaskDetailsView(props: {
  card: Accessor<AgentTaskCard>; resources: ThreadViewResources; copyText: CopyText;
  expansions: ExpansionStore; height: number;
  setScroll?: (value: ScrollBoxRenderable | undefined) => void;
}) {
  const renderer = useRenderer();
  const theme = props.resources.theme;
  const [tab, setTab] = createSignal<"prompt" | "trace">("prompt");
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>();
  onCleanup(() => props.setScroll?.(undefined));
  return <box width="100%" height={props.height} flexShrink={0} flexDirection="column">
    <box width="100%" height={1} flexShrink={0} flexDirection="row" gap={2}>
      {(["prompt", "trace"] as const).map((value) =>
        <text height={1} wrapMode="none" selectable={false} fg={tab() === value ? theme.accent : theme.muted}
          attributes={tab() === value ? bold : 0}
          onMouseUp={(event) => {
            if (event.button !== MouseButton.LEFT || event.isDragging || renderer.getSelection()?.getSelectedText()) return;
            event.stopPropagation();
            setTab(value);
          }}>{value === "prompt" ? "Prompt" : "Trace"}</text>
      )}
    </box>
    <Show when={tab()} keyed>
      {(active: "prompt" | "trace") => <scrollbox
        ref={(value) => { setScroll(value); props.setScroll?.(value); }} width="100%" height={Math.max(1, props.height - 1)}
        flexShrink={0} stickyScroll={active === "trace"} stickyStart={active === "trace" ? "bottom" : "top"}
        viewportCulling={true} scrollAcceleration={wheelScrollAcceleration} verticalScrollbarOptions={{ visible: false }}>
        <Show when={active === "prompt"} fallback={
          <>
            <text width="100%" flexShrink={0} wrapMode="word" fg={theme.nameAccent} marginBottom={1}>
              {props.card().summary.providerId}/{props.card().summary.modelId}
            </text>
            <TranscriptWindow items={props.card().trace} scroll={scroll}>
              {(block) => <TranscriptItemView block={block} resources={props.resources} expansions={props.expansions} copyText={props.copyText} />}
            </TranscriptWindow>
            <Show when={!props.card().trace.length}>
              <text fg={theme.muted}>{props.card().summary.status === "running" ? "waiting for output…" : "No trace recorded."}</text>
            </Show>
            <Show when={props.card().summary.error}>
              <text width="100%" wrapMode="word" flexShrink={0} fg={theme.error}>{props.card().summary.error}</text>
            </Show>
          </>
        }>
          <Show when={props.card().prompt} fallback={
            <text width="100%" wrapMode="word" fg={theme.muted}>
              {props.card().summary.status === "running" ? "Waiting for worker input…" : "No task prompt was recorded."}
            </text>
          }>
            <box width="100%" flexDirection="column" flexShrink={0}>
              <ReplyCopyButton content={props.card().prompt!} resources={props.resources} copyText={props.copyText} />
              <text width="100%" wrapMode="word" flexShrink={0} fg={theme.softText}>{props.card().prompt}</text>
            </box>
          </Show>
        </Show>
      </scrollbox>}
    </Show>
  </box>;
}

function AgentTaskCardView(props: {
  card: Accessor<AgentTaskCard>; resources: ThreadViewResources; expansion: TranscriptExpansion; expansions: ExpansionStore;
  copyText: CopyText;
}) {
  const renderer = useRenderer();
  const expanded = props.expansion.expanded;
  const summary = () => props.card().summary;
  const elapsed = () => `${(summary().elapsedMs / 1000).toFixed(1)}s`;
  const usage = () => summary().usage?.totalTokens ?? 0;
  const status = () => taskStatus(summary(), props.resources.theme);
  const theme = props.resources.theme;
  return (
    <box
      id={`task-view:${summary().taskId}`}
      flexDirection="column"
      width="100%"
      marginBottom={1}
    >
      <box flexDirection="row" width="100%" height={1} onMouseUp={(event) => {
        if (event.button === MouseButton.LEFT && !renderer.getSelection()?.getSelectedText()) {
          event.stopPropagation();
          props.expansion.toggle();
        }
      }}>
        <Show when={summary().status === "running"} fallback={
          <text width={2} height={1} wrapMode="none" fg={status().color}>{status().icon} </text>
        }>
          <SpinnerText fg={theme.spark} />
          <text width={1} height={1}> </text>
        </Show>
        <text flexShrink={1} minWidth={0} height={1} wrapMode="none" truncate={true} fg={theme.text} attributes={bold}>
          {summary().title}
        </text>
        <text flexGrow={1} flexShrink={2} minWidth={0} marginLeft={2} height={1} wrapMode="none" truncate={true} fg={theme.muted}>
          {summary().status} · {summary().providerId}/{summary().modelId} · r{summary().revision} · {elapsed()} · ctx {summary().contextTokens} · usage {usage()}
        </text>
        <text marginLeft={1} flexShrink={0} height={1} wrapMode="none" fg={theme.muted} selectable={false}>
          {expanded() ? STATUS_ICONS.expanded : STATUS_ICONS.collapsed}
        </text>
      </box>
      <Show when={expanded()}>
        <box flexDirection="row" width="100%" paddingTop={1}>
          <text width={2} height={1} flexShrink={0} wrapMode="none" fg={theme.faint} selectable={false}>{TRANSCRIPT_MARKS.result}</text>
          <box flexDirection="column" flexBasis={0} flexGrow={1} minWidth={1}>
            <AgentTaskDetailsView card={props.card} resources={props.resources} copyText={props.copyText}
              expansions={props.expansions} height={20} />
          </box>
        </box>
      </Show>
    </box>
  );
}

function LiveThinkingView(props: {
  block: Accessor<TranscriptItem>; resources: ThreadViewResources; expansion: TranscriptExpansion;
}) {
  const block = props.block;
  const theme = props.resources.theme;
  const duration = () => elapsedLabel(block().startedAt, block().finishedAt);
  return (
    <Show
      when={block().streaming}
      fallback={
        <ThinkingView
          content={block().content}
          heading={duration() ? `thought ${duration()}` : "thinking"}
          resources={props.resources}
          expansion={props.expansion}
        />
      }
    >
      <box flexDirection="column" width="100%" marginBottom={1}>
        <box flexDirection="row" width="100%" height={1}>
          <SpinnerText fg={theme.thinking} />
          <text width={1} height={1} flexShrink={0}> </text>
          <text height={1} wrapMode="none" fg={theme.thinking} attributes={italic}>thinking</text>
        </box>
        <Show when={block().content}>
          <text fg={theme.thinking} attributes={italic} wrapMode="word" marginLeft={2}>{block().content}</text>
        </Show>
      </box>
    </Show>
  );
}

function TranscriptItemView(props: {
  block: Accessor<TranscriptItem>; resources: ThreadViewResources; expansions: ExpansionStore;
  copyText: CopyText;
}) {
  const block = props.block;
  const expansion = props.expansions(block().id);
  const theme = props.resources.theme;
  // Replies, thinking and notes carry a gutter mark; tools and workers sit in the content column.
  return (
    <Switch fallback={
      <box flexDirection="row" width="100%" marginBottom={1}>
        <text width={2} height={1} flexShrink={0} wrapMode="none" selectable={false} fg={theme.accent}>{TRANSCRIPT_MARKS.reply}</text>
        <box flexDirection="column" flexBasis={0} flexGrow={1} minWidth={1}>
          <markdown
            id={`transcript-markdown-${block().id}`}
            content={normalizeMarkdownForTerminal(block().content)}
            width="100%"
            syntaxStyle={props.resources.syntaxStyle}
            fg={theme.text}
            conceal={true}
            streaming={true}
            internalBlockMode="top-level"
            maxWidth={180}
          />
          <Show when={!block().streaming && block().replyCopyContent}>
            <ReplyCopyButton content={block().replyCopyContent!} resources={props.resources} copyText={props.copyText} />
          </Show>
        </box>
      </box>
    }>
      <Match when={block().kind === "thinking"}>
        <LiveThinkingView block={block} resources={props.resources} expansion={expansion} />
      </Match>
      <Match when={block().kind === "tool"}>
        <box width="100%" paddingLeft={2}>
          <ToolOutputView tool={block().tool!} content={block().content} resources={props.resources} expansion={expansion} />
        </box>
      </Match>
      <Match when={block().kind === "compaction" || block().kind === "interrupted"}>
        <CompactionInfo content={block().content} detail={block().detail} resources={props.resources} expansion={expansion} />
      </Match>
      <Match when={block().kind === "agent_task" && block().agentTask !== undefined}>
        <box width="100%" paddingLeft={2}>
          <AgentTaskCardView card={() => block().agentTask!} resources={props.resources} expansion={expansion}
            expansions={props.expansions} copyText={props.copyText} />
        </box>
      </Match>
    </Switch>
  );
}

interface TranscriptRow {
  id: string;
  kind: "user" | "item";
  item?: TranscriptItem;
  last?: boolean;
}

export function TranscriptTurnsView(props: {
  items: readonly TranscriptItem[];
  liveTurn?: LiveTurn | undefined;
  resources: ThreadViewResources;
  copyText: CopyText;
  scroll: Accessor<ScrollBoxRenderable | undefined>;
}) {
  const expansions = createTranscriptExpansion();
  const history = createMemo(() => groupTranscriptTurns(props.items));
  const groups = createMemo(() => {
    const byId = new Map(history().map((group) => [group.id, group]));
    const live = props.liveTurn;
    if (live) {
      const user = projectLiveUser(live);
      byId.set(user.id, { id: user.id, user, items: live.blocks });
    }
    return byId;
  });
  const rows = createMemo(() => {
    const output: TranscriptRow[] = [];
    for (const group of groups().values()) {
      if (group.user) output.push({ id: group.user.id, kind: "user", item: group.user });
      group.items.forEach((item, index) => output.push({
        id: item.id, kind: "item", item, last: index === group.items.length - 1,
      }));
    }
    return output;
  });
  // Stable block keys preserve the visible controls during live-to-history handoff;
  // expansion state also survives eviction from the viewport.
  return <TranscriptWindow items={rows()} scroll={props.scroll} estimateHeight={(row) => row.kind === "user" ? 2 : 8}>
    {(row) => <Switch>
      <Match when={row().kind === "user"}>
        <UserMessageCard item={row().item!} resources={props.resources} />
      </Match>
      <Match when={row().kind === "item"}>
        <box width="100%" flexDirection="column" paddingLeft={1} paddingRight={2} paddingBottom={row().last ? 1 : 0} flexShrink={0}>
          <TranscriptItemView block={() => row().item!} resources={props.resources} expansions={expansions} copyText={props.copyText} />
        </box>
      </Match>
    </Switch>}
  </TranscriptWindow>;
}


const WELCOME_HINTS: ReadonlyArray<readonly [keys: string, description: string]> = [
  ["/session", "resume work"],
  ["/thread search", "<query>  search history"],
  ["/agent", "choose models & enable agents"],
  ["Ctrl+V / Alt+V", "paste image"],
  ["Shift+Tab", "change thinking level"],
  ["Ctrl+C / Alt+C", "copy selection · drag to select, Esc clears"],
];

export function WelcomeView(props: { resources: ThreadViewResources }) {
  const theme = props.resources.theme;
  return (
    <box flexDirection="column" width="100%" height="100%" alignItems="center" justifyContent="center">
      <ascii_font text="thread" font="tiny" color={theme.accentStrong} backgroundColor={theme.background} />
      <text fg={theme.softText} marginTop={1}>One project. One Session Tree.</text>
      <text fg={theme.muted} marginBottom={1}>Your interactions are the project's memory.</text>
      <box flexDirection="column">
        {WELCOME_HINTS.map(([keys, description]) => (
          <box flexDirection="row" height={1}>
            <text width={16} height={1} flexShrink={0} wrapMode="none" fg={theme.accentDim}>{keys}</text>
            <text height={1} wrapMode="none" truncate={true} fg={theme.muted}>{description}</text>
          </box>
        ))}
      </box>
    </box>
  );
}
