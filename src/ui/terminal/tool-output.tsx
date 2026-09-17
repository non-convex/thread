import { MouseButton, type TextRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { TranscriptTool } from "../state.js";
import type { ThreadViewResources } from "./resources.js";
import { SpinnerText } from "./spinner.js";
import { bold, STATUS_ICONS } from "./theme.js";
import { cleanToolText, formatToolText, presentTool, toolArguments, toolPreview } from "./tool-presentation.js";

export function ToolOutputView(props: { tool: TranscriptTool; content: string; resources: ThreadViewResources }) {
  const theme = props.resources.theme;
  const renderer = useRenderer();
  const [expanded, setExpanded] = createSignal(false);
  const [titleClipped, setTitleClipped] = createSignal(false);
  let titleText: TextRenderable | undefined;
  const [bodyWidth, setBodyWidth] = createSignal(70);
  const running = () => props.tool.status === "running";
  const waiting = () => props.tool.status === "queued";
  const failed = () => props.tool.status === "failed";
  const colour = () => failed() ? theme.error : props.tool.status === "completed" ? theme.success : theme.muted;
  const icon = () => failed() ? STATUS_ICONS.error : props.tool.status === "completed" ? STATUS_ICONS.success
    : props.tool.status === "denied" ? "⊘" : waiting() ? "◷" : "−";
  const presentation = createMemo(() => presentTool(props.tool, props.content));
  const args = createMemo(() => cleanToolText(toolArguments(props.tool)));
  const body = createMemo(() => formatToolText(presentation().body));
  // History snapshots replace tool objects; unchanged preview inputs stay cached.
  const previewRows = createMemo(() => props.tool.name === "edit" || props.tool.name === "write" ? 10 : 5);
  const tailPreview = createMemo(() => props.tool.name === "bash");
  const preview = createMemo(() => toolPreview(body(), bodyWidth(), previewRows(), tailPreview()));
  const result = createMemo(() => formatToolText(props.content));
  const output = createMemo(() => presentation().diff ? body() : expanded() ? result() : preview().text);
  const diffLines = createMemo(() => {
    const lines = body().split("\n");
    // Colour original lines so wrapped continuations retain their addition/removal colour.
    return expanded() ? lines : lines.slice(0, previewRows());
  });
  const duration = () => props.tool.durationMs === undefined ? "" : `${(props.tool.durationMs / 1000).toFixed(1)}s`;
  return (
    <box
      id={`tool-view:${props.tool.id}`}
      flexDirection="column"
      width="100%"
      marginBottom={1}
      onMouseUp={(event) => {
        if (event.button !== MouseButton.LEFT || renderer.getSelection()?.getSelectedText()) return;
        event.stopPropagation();
        setExpanded((value) => !value);
      }}
    >
      <box flexDirection="row" width="100%">
        <Show when={running()} fallback={<text width={2} height={1} fg={colour()}>{icon()}</text>}>
          <SpinnerText fg={theme.spark} />
          <text width={1} height={1}> </text>
        </Show>
        <text flexShrink={0} height={1} fg={theme.accent} attributes={bold}>{props.tool.name}</text>
        <text
          marginLeft={2} flexBasis={0} flexGrow={1} flexShrink={1} minWidth={1}
          maxHeight={props.tool.name === "bash" ? 3 : 1} wrapMode="word" truncate={true}
          fg={theme.text}
          ref={(node) => { titleText = node; }}
          on:line-info-change={() => setTitleClipped(!!titleText && titleText.virtualLineCount > titleText.height)}
        >{args()}</text>
        <Show when={duration()}>
          <text marginLeft={1} flexShrink={0} height={1} fg={theme.faint}>{duration()}</text>
        </Show>
        <text marginLeft={1} flexShrink={0} width={4} height={1} fg={theme.muted} selectable={false}>
          {titleClipped() ? "… " : "  "}{expanded() ? STATUS_ICONS.expanded : STATUS_ICONS.collapsed}
        </text>
      </box>
      <box flexDirection="column" width="100%" paddingLeft={3}>
        <Show when={presentation().summary}>
          <text fg={failed() ? theme.error : theme.muted} wrapMode="word">{presentation().summary}</text>
        </Show>
        <Show when={presentation().notice}>
          <text fg={theme.muted} wrapMode="word">{presentation().notice}</text>
        </Show>
        <Show when={output()}>
          {/* Explicitly reset height on expansion; omitting a spread prop leaves the native constraint in place. */}
          <box flexDirection="column" width="100%" flexShrink={0}
            height={expanded() ? "auto" : preview().text.split("\n").length} overflow="hidden"
            onSizeChange={function () { setBodyWidth(this.width); }}>
            <Show when={presentation().diff} fallback={
              <text flexShrink={0} fg={failed() ? theme.error : theme.muted} wrapMode={expanded() ? "word" : "char"}>{output()}</text>
            }>
              <For each={diffLines()}>
                {(line) => <text width="100%" flexShrink={0} wrapMode="char" fg={line.startsWith("+") ? theme.diffAdded : line.startsWith("-") ? theme.diffRemoved : theme.muted}>{line || " "}</text>}
              </For>
            </Show>
          </box>
          <Show when={!expanded() && preview().clipped}>
            <text fg={theme.faint}>… preview · click to expand</text>
          </Show>
        </Show>
      </box>
    </box>
  );
}
