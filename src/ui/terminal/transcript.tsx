import { MouseButton } from "@opentui/core";
import { createMemo, createSignal, For, Index, Match, Show, Switch, type Accessor, type JSX } from "solid-js";
import type { AgentTaskCard, LiveBlock, LiveTurn, TranscriptItem } from "../state.js";
import { bold, dim, dimItalic, italic } from "./theme.js";
import { projectLiveUser } from "./transcript-projection.js";
import type { ThreadViewResources } from "./resources.js";
import { SpinnerText } from "./spinner.js";

const FENCE_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  c: "c",
  cc: "cpp",
  cpp: "cpp",
  cts: "typescript",
  cxx: "cpp",
  h: "c",
  hpp: "cpp",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  mts: "typescript",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  ts: "typescript",
  tsx: "typescript",
  txt: "text",
  yml: "yaml",
};

/** Normalize source-range fence annotations into languages understood by OpenTUI. */
export function normalizeMarkdownForTerminal(content: string): string {
  return content.replace(
    /^(\s{0,3})(`{3,}|~{3,})([^\r\n]*)$/gm,
    (line, indent: string, fence: string, rawInfo: string) => {
      const info = rawInfo.trim();
      if (!info) return line;
      const first = info.split(/\s+/, 1)[0] ?? "";
      if (/^[a-z0-9_+.-]+$/i.test(first)) return `${indent}${fence}${first}`;
      const extension = info.match(/\.([a-z0-9]+)(?:$|[\s,:}\]])/i)?.[1]?.toLowerCase();
      const language = extension ? FENCE_LANGUAGE_BY_EXTENSION[extension] : undefined;
      return `${indent}${fence}${language ?? ""}`;
    },
  );
}

function toolArgs(args: Record<string, unknown>): string {
  for (const key of ["path", "command", "pattern", "query"]) {
    const value = args[key];
    if (typeof value === "string") return value.replace(/\s+/g, " ").slice(0, 100);
  }
  const encoded = JSON.stringify(args);
  return encoded === "{}" ? "" : encoded.slice(0, 100);
}

function elapsedLabel(startedAt: number | undefined, finishedAt: number | undefined): string | undefined {
  if (startedAt === undefined || finishedAt === undefined || finishedAt < startedAt) return undefined;
  return `${((finishedAt - startedAt) / 1000).toFixed(1)}s`;
}

/* ── Turn grouping ────────────────────────────────────────────────────────
 * The design strings one agent turn (thinking → tools → reply) on a single
 * vertical rail. History arrives as a flat item list, so group each user
 * message with the agent items that follow it.
 */
export interface TranscriptTurnGroup {
  id: string;
  user: TranscriptItem | undefined;
  items: TranscriptItem[];
}

export function groupTranscriptTurns(items: readonly TranscriptItem[]): TranscriptTurnGroup[] {
  const groups: TranscriptTurnGroup[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      groups.push({ id: item.id, user: item, items: [] });
      continue;
    }
    const last = groups.at(-1);
    if (last) last.items.push(item);
    else groups.push({ id: item.id, user: undefined, items: [item] });
  }
  return groups;
}

/* ── Group identity ───────────────────────────────────────────────────────
 * `projectTranscript` rebuilds every TranscriptItem from the session log on
 * each sync, and grouping then allocates fresh group objects. Solid's <For>
 * keys rows by reference, so handing it new objects tears down and rebuilds
 * every completed turn — including their markdown renderables — whenever the
 * controller notifies. During a turn that happens per flushed delta batch, so
 * earlier replies visibly re-wrap and the sticky-bottom scrollbox re-anchors.
 * Reuse the previous object for any group whose values did not change so <For>
 * leaves those rows mounted.
 */

function sameTranscriptItem(left: TranscriptItem, right: TranscriptItem): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.content === right.content
    && left.isError === right.isError
    && left.name === right.name
    && left.args === right.args
    && left.label === right.label
    && JSON.stringify(left.agentTask) === JSON.stringify(right.agentTask);
}

function sameTurnGroup(left: TranscriptTurnGroup, right: TranscriptTurnGroup): boolean {
  if (left.id !== right.id) return false;
  if ((left.user === undefined) !== (right.user === undefined)) return false;
  if (left.user && right.user && !sameTranscriptItem(left.user, right.user)) return false;
  if (left.items.length !== right.items.length) return false;
  return left.items.every((item, index) => sameTranscriptItem(item, right.items[index]!));
}

export function reconcileTurnGroups(
  next: readonly TranscriptTurnGroup[],
  previous: readonly TranscriptTurnGroup[],
): TranscriptTurnGroup[] {
  if (previous.length === 0) return [...next];
  const byId = new Map(previous.map((group) => [group.id, group] as const));
  return next.map((group) => {
    const earlier = byId.get(group.id);
    return earlier && sameTurnGroup(group, earlier) ? earlier : group;
  });
}

/* ── Shared bits ────────────────────────────────────────────────────────── */

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

/**
 * One agent turn (thinking, tools and reply) sits on a slightly raised surface
 * so the group reads as one unit. This replaces the earlier accent rail: the
 * boundary of the tinted block carries the grouping, which stays legible while
 * scrolling instead of relying on a label that leaves the viewport. A one-line
 * label anchors the top.
 */
function TurnBlock(props: { label: string; resources: ThreadViewResources; children: JSX.Element }) {
  const theme = props.resources.theme;
  return (
    <box flexDirection="column" width="100%" marginBottom={1}>
      <box flexDirection="column" width="100%" backgroundColor={theme.surface} paddingX={1} paddingTop={1}>
        <text height={1} wrapMode="none" fg={theme.accentDim} attributes={bold} marginBottom={1}>
          {props.label}
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
      {/* Outline only: the composer already owns the filled rounded box, so a
          second filled card would collide with it and weigh the transcript down.
          The border alone is enough to read the message as user input. */}
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

/* ── Thinking preview ─────────────────────────────────────────────────────
 * Completed thinking is no longer fully hidden: a collapsed block keeps up
 * to five terminal rows visible, and clicking anywhere in the block toggles
 * the full wrapped text.
 */
const COLLAPSED_THINKING_LINES = 5;
// There is no terminal width in the shared transcript resource. Use a
// conservative estimate so narrow terminals still get an expand affordance;
// an unnecessary affordance is safer than clipped text with no way to reveal it.
const THINKING_ESTIMATE_COLUMNS = 40;

type StringSource = string | Accessor<string>;

function sourceValue(source: StringSource | undefined, fallback: string): string {
  return (typeof source === "function" ? source() : source ?? fallback).trim();
}

function estimatedThinkingLines(content: string): number {
  if (!content) return 0;
  return content.split("\n").reduce(
    (total, line) => total + Math.max(1, Math.ceil([...line].length / THINKING_ESTIMATE_COLUMNS)),
    0,
  );
}

function ThinkingView(props: {
  content: StringSource;
  heading?: StringSource;
  resources: ThreadViewResources;
}) {
  const theme = props.resources.theme;
  const [expanded, setExpanded] = createSignal(false);
  const content = createMemo(() => sourceValue(props.content, ""));
  const estimatedLines = createMemo(() => estimatedThinkingLines(content()));
  const collapsible = () => estimatedLines() > COLLAPSED_THINKING_LINES;
  const heading = () => `◇ ${sourceValue(props.heading, "thinking")}`;
  return (
    <box
      flexDirection="column"
      width="100%"
      marginBottom={1}
      onMouseDown={(event) => {
        if (event.button === MouseButton.LEFT && collapsible()) {
          setExpanded((value) => !value);
        }
      }}
    >
      <box flexDirection="row" width="100%" height={1}>
        <text
          height={1}
          wrapMode="none"
          truncate={true}
          fg={theme.thinkingDim}
          attributes={dimItalic}
          selectable={false}
        >
          {collapsible()
            ? `${heading()} ${expanded() ? "▾" : "▸"} ${estimatedLines()} lines`
            : heading()}
        </text>
      </box>
      <Show when={content()}>
        <Show
          when={expanded()}
          fallback={
            <box
              flexDirection="column"
              width="100%"
              maxHeight={COLLAPSED_THINKING_LINES}
              overflow="hidden"
            >
              <text
                fg={theme.thinkingDim}
                attributes={italic}
                wrapMode="word"
                marginLeft={2}
                selectable={false}
              >
                {content()}
              </text>
            </box>
          }
        >
          <box flexDirection="column" width="100%">
            <text
              fg={theme.thinkingDim}
              attributes={italic}
              wrapMode="word"
              marginLeft={2}
              selectable={false}
            >
              {content()}
            </text>
          </box>
        </Show>
      </Show>
    </box>
  );
}

/* ── History items ──────────────────────────────────────────────────────── */

function HistoryToolItem(props: { item: TranscriptItem; resources: ThreadViewResources }) {
  const theme = props.resources.theme;
  const failed = () => props.item.isError === true;
  const summary = () => {
    const content = props.item.content.trim();
    return content && content !== props.item.args ? content : "";
  };
  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="row" width="100%" height={1}>
        <text width={2} height={1} wrapMode="none" fg={failed() ? theme.error : theme.success}>
          {failed() ? "×" : "✓"}
        </text>
        <text height={1} wrapMode="none" fg={theme.softText} attributes={bold}>
          {props.item.name ?? props.item.label ?? "tool"}
        </text>
        <text flexGrow={1} height={1} wrapMode="none" truncate={true} fg={theme.muted}>
          {props.item.args ? `  ${props.item.args}` : ""}
        </text>
        <Show when={props.item.elapsed}>
          <text width={6} flexShrink={0} height={1} wrapMode="none" truncate={true} fg={theme.faint}>
            {props.item.elapsed}
          </text>
        </Show>
      </box>
      <Show when={failed() && props.item.content}>
        <text fg={theme.error} wrapMode="word" marginLeft={2}>{props.item.content}</text>
      </Show>
      <Show when={!failed() && summary()}>
        <text height={1} wrapMode="none" truncate={true} fg={theme.faint} marginLeft={2}>{summary()}</text>
      </Show>
    </box>
  );
}

function CompactionInfo(props: { content: string; resources: ThreadViewResources }) {
  return (
    <box flexDirection="row" width="100%" height={1} marginBottom={1}>
      <text width={2} height={1} wrapMode="none" fg={props.resources.theme.spark}>◇</text>
      <text height={1} wrapMode="none" fg={props.resources.theme.muted} attributes={dim}>{props.content}</text>
    </box>
  );
}

function taskStatus(summary: AgentTaskCard["summary"], theme: ThreadViewResources["theme"]): { icon: string; color: string } {
  if (summary.status === "preparing" || summary.status === "running") return { icon: "◌", color: theme.spark };
  if (summary.status === "applied") return { icon: "✓", color: theme.success };
  if (summary.status === "awaiting_review") return { icon: "◇", color: theme.warning };
  if (summary.status === "failed") return { icon: "×", color: theme.error };
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
      onMouseDown={(event) => {
        if (event.button === MouseButton.LEFT) setExpanded((value) => !value);
      }}
    >
      <box flexDirection="row" width="100%" height={1}>
        <text width={2} height={1} wrapMode="none" fg={status().color}>{status().icon} </text>
        <text flexGrow={1} height={1} wrapMode="none" truncate={true} fg={props.resources.theme.softText} attributes={bold}>
          {summary().title}
        </text>
        <text height={1} wrapMode="none" fg={props.resources.theme.muted}>
          {summary().status} · {summary().providerId}/{summary().modelId} · r{summary().revision} · {elapsed()} · ctx {summary().contextTokens} · usage {usage()} · {summary().changedFiles} files {expanded() ? "▾" : "▸"}
        </text>
      </box>
      <Show when={expanded()}>
        <box flexDirection="column" width="100%" paddingLeft={2} paddingTop={1}>
          <Index each={props.card().trace}>
            {(block) => <LiveBlockView block={block} resources={props.resources} />}
          </Index>
          <Show when={summary().scopeViolations.length}>
            <text fg={props.resources.theme.error} wrapMode="word">scope violations: {summary().scopeViolations.join(", ")}</text>
          </Show>
          <Show when={summary().error}>
            {(error: Accessor<string>) => <text fg={props.resources.theme.error} wrapMode="word">{error()}</text>}
          </Show>
        </box>
      </Show>
    </box>
  );
}

function HistoryItemView(props: { item: TranscriptItem; resources: ThreadViewResources }) {
  const item = () => props.item;
  return (
    <Switch fallback={
      <box flexDirection="column" width="100%" marginBottom={1}>
        <MarkdownReply id={`history-markdown-${item().id}`} content={item().content} resources={props.resources} />
      </box>
    }>
      <Match when={item().kind === "tool"}>
        <HistoryToolItem item={item()} resources={props.resources} />
      </Match>
      <Match when={item().kind === "thinking"}>
        <ThinkingView content={() => item().content} resources={props.resources} />
      </Match>
      <Match when={item().kind === "compaction"}>
        <CompactionInfo content={item().content} resources={props.resources} />
      </Match>
      <Match when={item().kind === "agent_task" && item().agentTask !== undefined}>
        <AgentTaskCardView card={() => item().agentTask!} resources={props.resources} />
      </Match>
    </Switch>
  );
}

/* ── Live turn blocks ───────────────────────────────────────────────────── */

function LiveThinkingView(props: { block: Accessor<LiveBlock>; resources: ThreadViewResources }) {
  const block = props.block;
  const theme = props.resources.theme;
  const duration = () => elapsedLabel(block().startedAt, block().finishedAt);
  return (
    <Show
      when={block().streaming}
      fallback={
        <ThinkingView
          content={() => block().content}
          heading={() => (duration() ? `thought ${duration()}` : "thinking")}
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

function toolResultText(block: LiveBlock): string {
  const content = block.tool?.result?.content;
  return typeof content === "string" ? content.trim() : "";
}

function LiveToolView(props: { block: Accessor<LiveBlock>; resources: ThreadViewResources }) {
  const block = props.block;
  const theme = props.resources.theme;
  const tool = () => block().tool;
  const running = () => tool()?.status === "queued" || tool()?.status === "running";
  const failed = () => tool()?.status === "failed";
  const elapsed = () => elapsedLabel(tool()?.startedAt, tool()?.finishedAt);
  return (
    <box flexDirection="column" width="100%">
      <box flexDirection="row" width="100%" height={1}>
        <Show when={running()} fallback={
          <text width={2} height={1} wrapMode="none" fg={failed() ? theme.error : theme.success}>
            {failed() ? "×" : "✓"}
          </text>
        }>
          <SpinnerText fg={theme.spark} />
          <text width={1} height={1}> </text>
        </Show>
        <text height={1} wrapMode="none" fg={theme.softText} attributes={bold}>{tool()?.name ?? "tool"}</text>
        <text flexGrow={1} height={1} wrapMode="none" truncate={true} fg={theme.muted}>
          {tool() ? `  ${toolArgs(tool()!.args)}` : ""}
        </text>
        <Show when={elapsed()}>
          <text width={6} flexShrink={0} height={1} wrapMode="none" truncate={true} fg={theme.faint}>{elapsed()}</text>
        </Show>
      </box>
      <Show when={failed() && toolResultText(block())}>
        <text fg={theme.error} wrapMode="word" marginLeft={2}>{toolResultText(block())}</text>
      </Show>
    </box>
  );
}

function LiveBlockView(props: { block: Accessor<LiveBlock>; resources: ThreadViewResources }) {
  const block = props.block;
  return (
    <Switch fallback={
      <box flexDirection="column" width="100%" marginBottom={1}>
        <markdown
          id={`live-markdown-${block().id}`}
          content={normalizeMarkdownForTerminal(block().content)}
          width="100%"
          syntaxStyle={props.resources.syntaxStyle}
          fg={props.resources.theme.text}
          conceal={true}
          streaming={block().streaming ?? false}
          internalBlockMode="top-level"
          maxWidth={180}
        />
      </box>
    }>
      <Match when={block().kind === "thinking"}>
        <LiveThinkingView block={block} resources={props.resources} />
      </Match>
      <Match when={block().kind === "tool"}>
        <LiveToolView block={block} resources={props.resources} />
      </Match>
      <Match when={block().kind === "compaction"}>
        <CompactionInfo content={block().content} resources={props.resources} />
      </Match>
      <Match when={block().kind === "agent_task" && block().agentTask !== undefined}>
        <AgentTaskCardView card={() => block().agentTask!} resources={props.resources} />
      </Match>
    </Switch>
  );
}

export function LiveTurnView(props: {
  turn: Accessor<LiveTurn>;
  label: string;
  resources: ThreadViewResources;
}) {
  return (
    <>
      <UserMessageCard
        item={projectLiveUser(props.turn())}
        resources={props.resources}
      />
      <Show when={props.turn().blocks.length > 0}>
        <TurnBlock label={props.label} resources={props.resources}>
          {/* Live blocks are append-only. Index keeps each renderable alive while
              immutable block snapshots replace its value during streaming. */}
          <Index each={props.turn().blocks}>
            {(block) => <LiveBlockView block={block} resources={props.resources} />}
          </Index>
        </TurnBlock>
      </Show>
    </>
  );
}

/* ── Committed transcript ───────────────────────────────────────────────── */

function TranscriptTurnGroupView(props: { group: TranscriptTurnGroup; resources: ThreadViewResources }) {
  return (
    <>
      <Show when={props.group.user}>
        {(user: Accessor<TranscriptItem>) => <UserMessageCard item={user()} resources={props.resources} />}
      </Show>
      <Show when={props.group.items.length > 0}>
        <TurnBlock label="thread" resources={props.resources}>
          <For each={props.group.items}>
            {(item) => <HistoryItemView item={item} resources={props.resources} />}
          </For>
        </TurnBlock>
      </Show>
    </>
  );
}

export function TranscriptTurnsView(props: { items: readonly TranscriptItem[]; resources: ThreadViewResources }) {
  // Carry the previous grouping forward so unchanged turns keep their object
  // identity and <For> keeps their rows (and markdown renderables) mounted.
  let previous: TranscriptTurnGroup[] = [];
  const groups = createMemo(() => {
    previous = reconcileTurnGroups(groupTranscriptTurns(props.items), previous);
    return previous;
  });
  return (
    <For each={groups()}>
      {(group) => <TranscriptTurnGroupView group={group} resources={props.resources} />}
    </For>
  );
}

/* ── Welcome ────────────────────────────────────────────────────────────── */

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
      <text fg={theme.softText} marginBottom={1}>Persistent Session Tree · turn-level workspace rewind</text>
      <box flexDirection="row" height={1}>
        <text fg={theme.muted} height={1} wrapMode="none">type a task to start working, or </text>
        <text fg={theme.accentDim} height={1} wrapMode="none">/model</text>
        <text fg={theme.muted} height={1} wrapMode="none"> to switch model</text>
      </box>
      <box flexDirection="row" height={1}>
        <text fg={theme.accentDim} height={1} wrapMode="none">/thread</text>
        <text fg={theme.muted} height={1} wrapMode="none"> Sessions · history · search</text>
        <text fg={theme.accentDim} height={1} wrapMode="none"> · /subagent</text>
        <text fg={theme.muted} height={1} wrapMode="none"> workers</text>
        <text fg={theme.accentDim} height={1} wrapMode="none"> · ⇧⇥</text>
        <text fg={theme.muted} height={1} wrapMode="none"> thinking level</text>
      </box>
    </box>
  );
}
