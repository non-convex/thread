import { MouseButton } from "@opentui/core";
import { createMemo, createSignal, Show } from "solid-js";
import type { ThreadViewResources } from "./resources.js";
import { SpinnerText } from "./spinner.js";
import { bold, dimItalic, italic, STATUS_ICONS } from "./theme.js";

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

const COLLAPSED_THINKING_LINES = 5;
const THINKING_ESTIMATE_COLUMNS = 40;

function estimatedThinkingLines(content: string): number {
  if (!content) return 0;
  return content.split("\n").reduce(
    (total, line) => total + Math.max(1, Math.ceil([...line].length / THINKING_ESTIMATE_COLUMNS)),
    0,
  );
}

export function ThinkingView(props: {
  content: string;
  heading?: string;
  resources: ThreadViewResources;
}) {
  const theme = props.resources.theme;
  const [expanded, setExpanded] = createSignal(false);
  const content = createMemo(() => props.content.trim());
  const estimatedLines = createMemo(() => estimatedThinkingLines(content()));
  const collapsible = () => estimatedLines() > COLLAPSED_THINKING_LINES;
  const heading = () => `◇ ${(props.heading ?? "thinking").trim()}`;
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
            ? `${heading()} ${expanded() ? STATUS_ICONS.expanded : STATUS_ICONS.collapsed} ${estimatedLines()} lines`
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


const TOOL_OUTPUT_PREVIEW_LINES = 5;

function formatToolOutput(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
  try { return JSON.stringify(JSON.parse(trimmed), null, 2); }
  catch { return trimmed; }
}

export function ToolOutputView(props: {
  name: string;
  args: string;
  content: string;
  elapsed?: string | undefined;
  status: "queued" | "running" | "completed" | "failed";
  resources: ThreadViewResources;
}) {
  const theme = props.resources.theme;
  const running = () => props.status === "queued" || props.status === "running";
  const failed = () => props.status === "failed";
  const [expanded, setExpanded] = createSignal(false);
  const lines = createMemo(() => formatToolOutput(props.content).split("\n"));
  const collapsible = () => !running() && lines().length > TOOL_OUTPUT_PREVIEW_LINES;
  const preview = () => (expanded() ? lines() : lines().slice(0, TOOL_OUTPUT_PREVIEW_LINES)).join("\n");
  return (
    <box
      flexDirection="column"
      width="100%"
      marginBottom={1}
      onMouseDown={(event) => {
        if (event.button === MouseButton.LEFT && collapsible()) setExpanded((value) => !value);
      }}
    >
      <box flexDirection="row" width="100%" height={1}>
        <Show when={running()} fallback={
          <text width={2} height={1} wrapMode="none" fg={failed() ? theme.error : theme.success}>
            {failed() ? STATUS_ICONS.error : STATUS_ICONS.success}
          </text>
        }>
          <SpinnerText fg={theme.spark} />
          <text width={1} height={1}> </text>
        </Show>
        <text height={1} wrapMode="none" fg={theme.accent} attributes={bold}>{props.name}</text>
        <text flexGrow={1} height={1} wrapMode="none" truncate={true} fg={theme.text}>
          {props.args ? `  ${props.args}` : ""}
        </text>
        <Show when={props.elapsed}>
          <text width={6} flexShrink={0} height={1} wrapMode="none" truncate={true} fg={theme.faint}>{props.elapsed}</text>
        </Show>
        <Show when={collapsible()}>
          <text width={2} height={1} wrapMode="none" fg={theme.muted}>
            {expanded() ? ` ${STATUS_ICONS.expanded}` : ` ${STATUS_ICONS.collapsed}`}
          </text>
        </Show>
      </box>
      <Show when={!running() && preview()}>
        <box flexDirection="column" width="100%" marginLeft={2} paddingLeft={1}>
          <text fg={failed() ? theme.error : theme.muted} wrapMode="word">{preview()}</text>
        </box>
      </Show>
    </box>
  );
}
