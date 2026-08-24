import { Index, Show, type Accessor } from "solid-js";
import type { LiveBlock, LiveTurn, TranscriptItem } from "../state.js";
import { bold, dim, dimItalic, italic, type ThreadTerminalTheme } from "./theme.js";
import type { ThreadViewResources } from "./resources.js";

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

function labelFor(item: TranscriptItem): string {
  if (item.kind === "user") return "you";
  if (item.kind === "assistant") return "thread";
  if (item.kind === "thinking") return "think";
  if (item.kind === "compaction") return "compact";
  if (item.kind === "context_merge") return "import";
  if (item.kind === "tool") return item.label ?? "tool";
  return "note";
}

function colorFor(item: TranscriptItem, theme: ThreadTerminalTheme): string {
  if (item.kind === "assistant") return theme.accent;
  if (item.kind === "thinking") return theme.thinking;
  if (item.kind === "compaction") return theme.warning;
  if (item.kind === "context_merge") return theme.success;
  if (item.kind === "tool") return item.isError ? theme.error : theme.success;
  return theme.muted;
}

function gutterFor(item: TranscriptItem): string {
  if (item.kind === "tool") return item.isError ? "×" : "·";
  if (item.kind === "thinking") return "⋮";
  if (item.kind === "assistant") return "●";
  if (item.kind === "user") return "›";
  return "·";
}

export function TranscriptItemView(props: { item: TranscriptItem; resources: ThreadViewResources }) {
  const item = () => props.item;
  const theme = props.resources.theme;
  return (
    <box flexDirection="column" width="100%" paddingX={1} marginBottom={1}>
      <text fg={colorFor(item(), theme)} attributes={item().kind === "thinking" ? dimItalic : bold}>
        {gutterFor(item())} {labelFor(item())}
      </text>
      {item().kind === "tool" ? (
        <text fg={theme.softText} wrapMode="word" marginLeft={2}>{item().content}</text>
      ) : item().kind === "thinking" ? (
        <text fg={theme.thinking} attributes={italic} wrapMode="word" marginLeft={2}>{item().content}</text>
      ) : (
        <markdown
          content={normalizeMarkdownForTerminal(item().content)}
          width="100%"
          syntaxStyle={props.resources.syntaxStyle}
          fg={theme.text}
          conceal={true}
          streaming={true}
          marginLeft={2}
          maxWidth={180}
        />
      )}
    </box>
  );
}

export function WelcomeView(props: { resources: ThreadViewResources }) {
  return (
    <box flexDirection="column" width="100%" paddingX={1} marginBottom={1}>
      <text fg={props.resources.theme.muted} attributes={dim}>thread · project session</text>
      <text fg={props.resources.theme.muted}>type a task, /model, or /thread</text>
    </box>
  );
}

function LiveBlockView(props: { block: Accessor<LiveBlock>; resources: ThreadViewResources }) {
  const block = props.block;
  const tool = () => block().tool;
  const theme = props.resources.theme;
  return (
    <box flexDirection="column" width="100%" paddingX={1} marginBottom={1}>
      <Show
        when={block().kind === "tool" && tool()}
        fallback={
          <>
            <text
              fg={block().kind === "assistant" ? theme.accent : theme.thinking}
              attributes={block().kind === "assistant" ? bold : dimItalic}
            >
              {block().kind === "assistant" ? "● thread" : "⋮ think"}
            </text>
            <Show
              when={block().kind === "assistant"}
              fallback={<text fg={theme.thinking} attributes={italic} wrapMode="word" marginLeft={2}>{block().content}</text>}
            >
              <markdown
                id={`live-markdown-${block().id}`}
                content={normalizeMarkdownForTerminal(block().content)}
                width="100%"
                syntaxStyle={props.resources.syntaxStyle}
                fg={theme.text}
                conceal={true}
                streaming={block().streaming ?? false}
                internalBlockMode="top-level"
                marginLeft={2}
                maxWidth={180}
              />
            </Show>
          </>
        }
      >
        <text fg={tool()?.status === "failed" ? theme.error : theme.success} wrapMode="none" truncate={true}>
          · {tool()?.name}{tool() ? `  ${toolArgs(tool()!.args)}` : ""}{tool()?.status === "running" ? "  …" : ""}
        </text>
        <Show when={tool()?.status === "failed" && tool()?.result?.content}>
          <text fg={theme.error} wrapMode="word" marginLeft={2}>{tool()?.result?.content}</text>
        </Show>
      </Show>
    </box>
  );
}

export function LiveTurnView(props: { turn: Accessor<LiveTurn>; resources: ThreadViewResources }) {
  return (
    // Live blocks are append-only. Index keeps each renderable alive while
    // immutable block snapshots replace its value during streaming.
    <Index each={props.turn().blocks}>
      {(block) => <LiveBlockView block={block} resources={props.resources} />}
    </Index>
  );
}
