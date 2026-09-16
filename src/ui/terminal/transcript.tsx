import { MouseButton } from "@opentui/core";
import { createMemo, createSignal, For, Match, Show, Switch, type Accessor, type JSX } from "solid-js";
import type { AgentTaskCard, LiveTurn, TranscriptItem } from "../state.js";
import { bold, dim, italic, STATUS_ICONS } from "./theme.js";
import { groupTranscriptTurns, projectLiveUser, type TranscriptTurnGroup } from "./transcript-projection.js";
import { normalizeMarkdownForTerminal, ThinkingView } from "./transcript-content.js";
import { ToolOutputView } from "./tool-output.js";
import type { ThreadViewResources } from "./resources.js";
import { SpinnerText } from "./spinner.js";

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

function TurnBlock(props: { label: string; resources: ThreadViewResources; children: JSX.Element }) {
  const theme = props.resources.theme;
  return (
    <box flexDirection="column" width="100%">
      <box
        flexDirection="column"
        width="100%"
        paddingX={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <text height={1} wrapMode="none" fg={theme.accent} attributes={bold} marginBottom={1}>
          ▍{props.label}
        </text>
        {props.children}
      </box>
    </box>
  );
}

function UserMessageCard(props: { item: TranscriptItem; resources: ThreadViewResources }) {
  const theme = props.resources.theme;
  return (
    <box width="100%" flexDirection="row" justifyContent="flex-start" marginBottom={1} paddingLeft={1}>
      <box
        flexDirection="column"
        flexShrink={1}
        maxWidth="78%"
        border={true}
        borderStyle="rounded"
        borderColor={theme.border}
        paddingX={1}
      >
        <text height={1} wrapMode="none" fg={theme.muted} attributes={dim}>you</text>
        <text fg={theme.text} wrapMode="word">{props.item.content}</text>
      </box>
    </box>
  );
}

function CompactionInfo(props: { content: string; detail?: string | undefined; resources: ThreadViewResources }) {
  const [expanded, setExpanded] = createSignal(false);
  const expandable = () => Boolean(props.detail?.trim());
  const theme = props.resources.theme;
  return (
    <box
      flexDirection="column"
      width="100%"
      marginBottom={1}
      onMouseDown={(event) => {
        if (event.button === MouseButton.LEFT && expandable()) setExpanded((value) => !value);
      }}
    >
      <box flexDirection="row" width="100%" height={1}>
        <text width={2} height={1} wrapMode="none" fg={theme.spark}>◇</text>
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

function AgentTaskCardView(props: { card: Accessor<AgentTaskCard>; resources: ThreadViewResources }) {
  const [expanded, setExpanded] = createSignal(false);
  const summary = () => props.card().summary;
  const elapsed = () => `${(summary().elapsedMs / 1000).toFixed(1)}s`;
  const usage = () => summary().usage?.totalTokens ?? 0;
  const status = () => taskStatus(summary(), props.resources.theme);
  return (
    <box
      flexDirection="column"
      width="100%"
      border={true}
      borderStyle="rounded"
      borderColor={status().color}
      paddingX={1}
      marginBottom={1}
    >
      <box flexDirection="row" width="100%" height={1} onMouseUp={(event) => {
        if (event.button === MouseButton.LEFT) setExpanded((value) => !value);
      }}>
        <text width={2} height={1} wrapMode="none" fg={status().color}>{status().icon} </text>
        <text flexGrow={1} height={1} wrapMode="none" truncate={true} fg={props.resources.theme.softText} attributes={bold}>
          {summary().title}
        </text>
        <text height={1} wrapMode="none" fg={props.resources.theme.muted}>
          {summary().status} · {summary().providerId}/{summary().modelId} · r{summary().revision} · {elapsed()} · ctx {summary().contextTokens} · usage {usage()} {expanded() ? STATUS_ICONS.expanded : STATUS_ICONS.collapsed}
        </text>
      </box>
      <Show when={expanded()}>
        <box flexDirection="column" width="100%" paddingLeft={2} paddingTop={1}>
          <TranscriptItems items={props.card().trace} resources={props.resources} />
          <Show when={summary().error}>
            {(error: Accessor<string>) => <text fg={props.resources.theme.error} wrapMode="word">{error()}</text>}
          </Show>
        </box>
      </Show>
    </box>
  );
}

function LiveThinkingView(props: { block: Accessor<TranscriptItem>; resources: ThreadViewResources }) {
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
        />
      }
    >
      <box flexDirection="column" width="100%" marginBottom={1}>
        <box flexDirection="row" width="100%" height={1}>
          <SpinnerText fg={theme.thinking} />
          <text height={1} wrapMode="none" fg={theme.thinking} attributes={italic}> thinking</text>
        </box>
        <Show when={block().content}>
          <text fg={theme.thinking} attributes={italic} wrapMode="word" marginLeft={2}>{block().content}</text>
        </Show>
      </box>
    </Show>
  );
}

function TranscriptItemView(props: { block: Accessor<TranscriptItem>; resources: ThreadViewResources }) {
  const block = props.block;
  return (
    <Switch fallback={
      <box flexDirection="column" width="100%" marginBottom={1}>
        <markdown
          id={`transcript-markdown-${block().id}`}
          content={normalizeMarkdownForTerminal(block().content)}
          width="100%"
          syntaxStyle={props.resources.syntaxStyle}
          fg={props.resources.theme.text}
          conceal={true}
          streaming={true}
          internalBlockMode="top-level"
          maxWidth={180}
        />
      </box>
    }>
      <Match when={block().kind === "thinking"}>
        <LiveThinkingView block={block} resources={props.resources} />
      </Match>
      <Match when={block().kind === "tool"}>
        <ToolOutputView tool={block().tool!} content={block().content} resources={props.resources} />
      </Match>
      <Match when={block().kind === "compaction" || block().kind === "interrupted"}>
        <CompactionInfo content={block().content} detail={block().detail} resources={props.resources} />
      </Match>
      <Match when={block().kind === "agent_task" && block().agentTask !== undefined}>
        <AgentTaskCardView card={() => block().agentTask!} resources={props.resources} />
      </Match>
    </Switch>
  );
}

function TranscriptItems(props: { items: readonly TranscriptItem[]; resources: ThreadViewResources }) {
  const byId = createMemo(() => new Map(props.items.map((item) => [item.id, item])));
  return <For each={[...byId().keys()]}>{(id) => {
    const block = createMemo(() => byId().get(id)!);
    return <TranscriptItemView block={block} resources={props.resources} />;
  }}</For>;
}

function TranscriptTurnGroupView(props: { group: TranscriptTurnGroup; resources: ThreadViewResources }) {
  return (
    <>
      <Show when={props.group.user}>
        {(user: Accessor<TranscriptItem>) => <UserMessageCard item={user()} resources={props.resources} />}
      </Show>
      <Show when={props.group.items.length > 0}>
        <TurnBlock label="thread" resources={props.resources}>
          <TranscriptItems items={props.group.items} resources={props.resources} />
        </TurnBlock>
      </Show>
    </>
  );
}

export function TranscriptTurnsView(props: {
  items: readonly TranscriptItem[];
  liveTurn?: LiveTurn | undefined;
  resources: ThreadViewResources;
}) {
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
  // The same turn and tool keys survive the live-to-history handoff. Keep their
  // components mounted, including user-controlled expansion and text selection.
  return <For each={[...groups().keys()]}>{(id) => {
    const group = createMemo(() => groups().get(id)!);
    return <TranscriptTurnGroupView group={group()} resources={props.resources} />;
  }}</For>;
}


export function WelcomeView(props: { resources: ThreadViewResources }) {
  const theme = props.resources.theme;
  return (
    <box flexDirection="column" width="100%" height="100%" alignItems="center" justifyContent="center">
      <box
        border={true}
        borderStyle="rounded"
        borderColor={theme.borderStrong}
        backgroundColor={theme.surface}
        paddingX={2}
        marginBottom={1}
      >
        <ascii_font text="thread" font="tiny" color={theme.accent} backgroundColor={theme.surface} />
      </box>
      <text fg={theme.softText}>One project. One Session Tree.</text>
      <text fg={theme.softText} marginBottom={1}>Your interactions are the project's memory.</text>
      <box flexDirection="row" height={1}>
        <text fg={theme.accentDim} height={1} wrapMode="none">/session</text>
        <text fg={theme.muted} height={1} wrapMode="none"> resume work · </text>
        <text fg={theme.accentDim} height={1} wrapMode="none">/thread search</text>
        <text fg={theme.muted} height={1} wrapMode="none"> {"<query>"} search history</text>
      </box>
      <box flexDirection="row" height={1}>
        <text fg={theme.accentDim} height={1} wrapMode="none">/agent</text>
        <text fg={theme.muted} height={1} wrapMode="none"> choose models &amp; enable agents</text>
      </box>
      <box flexDirection="row" height={1}>
        <text fg={theme.accentDim} height={1} wrapMode="none">Ctrl+V</text>
        <text fg={theme.muted} height={1} wrapMode="none"> / </text>
        <text fg={theme.accentDim} height={1} wrapMode="none">Alt+V</text>
        <text fg={theme.muted} height={1} wrapMode="none"> paste image</text>
        <text fg={theme.accentDim} height={1} wrapMode="none"> · Shift+Tab</text>
        <text fg={theme.muted} height={1} wrapMode="none"> change thinking level</text>
      </box>
    </box>
  );
}
