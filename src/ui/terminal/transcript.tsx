import { createMemo, For, Index, Show, type Accessor, type JSX } from "solid-js";
import type { LiveBlock, LiveTurn, TranscriptItem } from "../state.js";
import { bold, dim, dimItalic, italic } from "./theme.js";
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
 * message with the agent items that follow it. Leading non-user items (e.g.
 * an import right after a restore) form their own rail-less group.
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

/* ── Shared bits ────────────────────────────────────────────────────────── */

function MarkdownReply(props: {
  content: string;
  resources: ThreadViewResources;
}) {
  return (
    // OpenTUI 0.5.7 only paints markdown content in streaming mode.
    <markdown
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
 * The one core flourish from the spec: a 1-column accent rail on the left
 * that ties a turn's thinking, tools and reply together, anchored by a small
 * label. In the terminal the rail is a left border; the growth animation is
 * dropped — a static rail costs no frames.
 */
function TurnRail(props: { label: string; resources: ThreadViewResources; children: JSX.Element }) {
  const theme = props.resources.theme;
  return (
    <box flexDirection="column" width="100%" marginBottom={1}>
      <box
        flexDirection="column"
        width="100%"
        marginLeft={1}
        border={["left"]}
        borderColor={theme.accentDim}
        paddingLeft={1}
      >
        <text height={1} wrapMode="none" fg={theme.accentDim} attributes={bold} marginBottom={1}>
          ● {props.label}
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
        backgroundColor={theme.surface}
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

function HistoryItemView(props: { item: TranscriptItem; resources: ThreadViewResources }) {
  const item = () => props.item;
  const theme = props.resources.theme;
  const systemLabel = () => item().kind === "compaction" ? "◌ compact" : "◌ import";
  return (
    <Show
      when={item().kind === "tool"}
      fallback={
        <Show
          when={item().kind === "thinking"}
          fallback={
            <box flexDirection="column" width="100%" marginBottom={1}>
              <Show when={item().kind === "compaction" || item().kind === "context_merge"}>
                <text height={1} wrapMode="none" fg={item().kind === "compaction" ? theme.warning : theme.success} attributes={dim}>
                  {systemLabel()}
                </text>
              </Show>
              <MarkdownReply content={item().content} resources={props.resources} />
            </box>
          }
        >
          {/* Completed thinking collapses to a single line, per the spec. */}
          <text height={1} wrapMode="none" fg={theme.thinkingDim} attributes={dimItalic}>◇ thinking</text>
        </Show>
      }
    >
      <HistoryToolItem item={item()} resources={props.resources} />
    </Show>
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
        <box flexDirection="column" width="100%" marginBottom={1}>
          <text height={1} wrapMode="none" fg={theme.thinkingDim} attributes={dimItalic}>
            ◇ thought{duration() ? ` ${duration()}` : ""}
          </text>
        </box>
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
  const running = () => tool()?.status === "running";
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
          <SpinnerText fg={theme.accent} />
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
    <Show
      when={block().kind === "thinking"}
      fallback={
        <Show
          when={block().kind === "tool"}
          fallback={
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
          }
        >
          <LiveToolView block={block} resources={props.resources} />
        </Show>
      }
    >
      <LiveThinkingView block={block} resources={props.resources} />
    </Show>
  );
}

export function LiveTurnView(props: {
  turn: Accessor<LiveTurn>;
  label: string;
  resources: ThreadViewResources;
}) {
  return (
    <TurnRail label={props.label} resources={props.resources}>
      {/* Live blocks are append-only. Index keeps each renderable alive while
          immutable block snapshots replace its value during streaming. */}
      <Index each={props.turn().blocks}>
        {(block) => <LiveBlockView block={block} resources={props.resources} />}
      </Index>
    </TurnRail>
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
        <TurnRail label="thread" resources={props.resources}>
          <For each={props.group.items}>
            {(item) => <HistoryItemView item={item} resources={props.resources} />}
          </For>
        </TurnRail>
      </Show>
    </>
  );
}

export function TranscriptTurnsView(props: { items: readonly TranscriptItem[]; resources: ThreadViewResources }) {
  const groups = createMemo(() => groupTranscriptTurns(props.items));
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
      <text fg={theme.softText} marginBottom={1}>project session · versioned workspace and context</text>
      <box flexDirection="row" height={1}>
        <text fg={theme.muted} height={1} wrapMode="none">type a task to start working, or </text>
        <text fg={theme.accentDim} height={1} wrapMode="none">/model</text>
        <text fg={theme.muted} height={1} wrapMode="none"> to switch model</text>
      </box>
      <box flexDirection="row" height={1}>
        <text fg={theme.accentDim} height={1} wrapMode="none">/thread</text>
        <text fg={theme.muted} height={1} wrapMode="none"> branches · history · merges</text>
        <text fg={theme.accentDim} height={1} wrapMode="none"> · ⇧⇥</text>
        <text fg={theme.muted} height={1} wrapMode="none"> thinking level</text>
      </box>
    </box>
  );
}
