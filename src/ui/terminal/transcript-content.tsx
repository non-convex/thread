import { MouseButton } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { CopyText } from "./clipboard.js";
import type { TranscriptExpansion } from "./transcript-expansion.js";
import type { ThreadViewResources } from "./resources.js";
import { dimItalic, italic, STATUS_ICONS, TRANSCRIPT_MARKS } from "./theme.js";

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

export function ReplyCopyButton(props: { content: string; resources: ThreadViewResources; copyText: CopyText }) {
  const theme = props.resources.theme;
  const [status, setStatus] = createSignal<"idle" | "copying" | "written" | "attempted" | "failed">("idle");
  let pressed = false;
  let disposed = false;
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    disposed = true;
    clearTimeout(resetTimer);
  });
  const copy = async () => {
    if (status() === "copying") return;
    clearTimeout(resetTimer);
    setStatus("copying");
    // Copy the source, preserving Markdown and content outside the viewport.
    const result = await props.copyText(props.content);
    if (disposed) return;
    setStatus(result === "cancelled" ? "idle" : result);
    if (result === "written" || result === "attempted") {
      resetTimer = setTimeout(() => setStatus("idle"), 2_000);
    }
  };
  const label = () => {
    switch (status()) {
      case "copying": return "… copying";
      case "written": return "✓ copied";
      case "attempted": return "↗ sent";
      case "failed": return "! retry copy";
      default: return "⧉ copy";
    }
  };
  return <box flexDirection="row" width="100%" height={1} flexShrink={0} marginTop={1}>
    <text height={1} flexShrink={0} wrapMode="none" selectable={false}
      fg={status() === "written" ? theme.success : status() === "failed" ? theme.error : theme.muted}
      onMouseDown={(event) => {
        pressed = event.button === MouseButton.LEFT;
        event.stopPropagation();
      }}
      onMouseDrag={() => { pressed = false; }}
      onMouseOut={() => { pressed = false; }}
      onMouseUp={(event) => {
        const activate = pressed && event.button === MouseButton.LEFT && !event.isDragging;
        pressed = false;
        event.stopPropagation();
        if (activate) void copy();
      }}
    >{label()}</text>
  </box>;
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
  expansion: TranscriptExpansion;
}) {
  const theme = props.resources.theme;
  const renderer = useRenderer();
  const expanded = props.expansion.expanded;
  const content = createMemo(() => props.content.trim());
  const estimatedLines = createMemo(() => estimatedThinkingLines(content()));
  const collapsible = () => estimatedLines() > COLLAPSED_THINKING_LINES;
  const heading = () => (props.heading ?? "thinking").trim();
  return (
    <box
      flexDirection="column"
      width="100%"
      marginBottom={1}
      onMouseUp={(event) => {
        if (event.button === MouseButton.LEFT && collapsible() && !renderer.getSelection()?.getSelectedText()) {
          event.stopPropagation();
          props.expansion.toggle();
        }
      }}
    >
      <box flexDirection="row" width="100%" height={1}>
        <text width={2} height={1} flexShrink={0} wrapMode="none" fg={theme.thinkingDim} selectable={false}>{TRANSCRIPT_MARKS.thinking} </text>
        <text
          height={1}
          wrapMode="none"
          truncate={true}
          fg={theme.thinkingDim}
          attributes={dimItalic}
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
            >
              {content()}
            </text>
          </box>
        </Show>
      </Show>
    </box>
  );
}
