import { MouseButton } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { TranscriptTool } from "../state.js";
import type { ThreadViewResources } from "./resources.js";
import { SpinnerText } from "./spinner.js";
import { bold, STATUS_ICONS } from "./theme.js";
import { cleanToolText, displayArguments, formatToolText, presentTool, toolArguments, toolPreview } from "./tool-presentation.js";

export function ToolOutputView(props: { tool: TranscriptTool; content: string; resources: ThreadViewResources }) {
  const theme = props.resources.theme;
  const renderer = useRenderer();
  const [expanded, setExpanded] = createSignal(false);
  const [titleWidth, setTitleWidth] = createSignal(60);
  const [bodyWidth, setBodyWidth] = createSignal(70);
  const running = () => props.tool.status === "running";
  const waiting = () => props.tool.status === "queued";
  const failed = () => props.tool.status === "failed";
  const colour = () => failed() ? theme.error : props.tool.status === "completed" ? theme.success : theme.muted;
  const icon = () => failed() ? STATUS_ICONS.error : props.tool.status === "completed" ? STATUS_ICONS.success
    : props.tool.status === "denied" ? "⊘" : waiting() ? "◷" : "−";
  const presentation = createMemo(() => presentTool(props.tool, props.content));
  const args = createMemo(() => cleanToolText(toolArguments(props.tool)));
  const title = createMemo(() => toolPreview(args(), titleWidth() - 1, props.tool.name === "bash" ? 3 : 1));
  const body = createMemo(() => formatToolText(presentation().body));
  const preview = createMemo(() => toolPreview(body(), bodyWidth(), 5, props.tool.name === "bash"));
  const result = createMemo(() => formatToolText(props.content));
  const parameters = createMemo(() => formatToolText(displayArguments(props.tool.args)));
  const duration = () => props.tool.durationMs === undefined ? "" : `${(props.tool.durationMs / 1000).toFixed(1)}s`;
  return (
    <box id={`tool-view:${props.tool.id}`} flexDirection="column" width="100%" marginBottom={1}>
      <box
        flexDirection="row"
        width="100%"
        onMouseUp={(event) => {
          if (event.button !== MouseButton.LEFT || renderer.getSelection()?.getSelectedText()) return;
          event.stopPropagation();
          setExpanded((value) => !value);
        }}
      >
        <Show when={running()} fallback={<text width={2} height={1} fg={colour()}>{icon()}</text>}>
          <SpinnerText fg={theme.spark} />
          <text width={1} height={1}> </text>
        </Show>
        <text height={1} fg={theme.accent} attributes={bold}>{props.tool.name}</text>
        <text
          marginLeft={2} flexGrow={1} flexShrink={1} minWidth={1}
          height={Math.max(1, title().text.split("\n").length)} wrapMode="none" truncate={true}
          fg={theme.text} onSizeChange={function () { setTitleWidth(this.width); }}
        >{title().text}{title().clipped ? "…" : ""}</text>
        <Show when={duration()}>
          <text marginLeft={1} height={1} fg={theme.faint}>{duration()}</text>
        </Show>
        <text marginLeft={1} width={2} height={1} fg={theme.muted} selectable={false}>
          {expanded() ? STATUS_ICONS.expanded : STATUS_ICONS.collapsed}
        </text>
      </box>
      <box flexDirection="column" width="100%" paddingLeft={3}>
        <Show when={presentation().summary}>
          <text fg={failed() ? theme.error : theme.muted} wrapMode="word">{presentation().summary}</text>
        </Show>
        <Show when={presentation().notice}>
          <text fg={theme.muted} wrapMode="word">{presentation().notice}</text>
        </Show>
        <Show when={expanded()} fallback={
          <Show when={body()}>
            <box flexDirection="column" width="100%" maxHeight={5} overflow="hidden"
              onSizeChange={function () { setBodyWidth(this.width); }}>
              <Show when={presentation().diff} fallback={
                <text fg={failed() ? theme.error : theme.muted} wrapMode="char">{preview().text}</text>
              }>
                <For each={preview().text.split("\n")}>
                  {(line) => <text wrapMode="char" fg={line.startsWith("+") ? theme.success : line.startsWith("-") ? theme.error : theme.muted}>{line || " "}</text>}
                </For>
              </Show>
            </box>
            <Show when={preview().clipped}>
              <text fg={theme.faint}>… preview · click the tool heading for details</text>
            </Show>
          </Show>
        }>
          <text fg={theme.softText} attributes={bold}>Parameters</text>
          <text fg={theme.muted} wrapMode="word">{parameters()}</text>
          <Show when={presentation().diff}>
            <text fg={theme.softText} attributes={bold}>Changes</text>
            <text fg={theme.muted} wrapMode="word">{body()}</text>
          </Show>
          <Show when={result()}>
            <text fg={theme.softText} attributes={bold}>Result</text>
            <text fg={failed() ? theme.error : theme.muted} wrapMode="word">{result()}</text>
          </Show>
          <Show when={running() || waiting()}><text fg={theme.faint}>Result pending</text></Show>
        </Show>
      </box>
    </box>
  );
}
