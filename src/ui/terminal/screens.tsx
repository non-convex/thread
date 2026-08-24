import type { ScrollBoxRenderable } from "@opentui/core";
import { For, Match, Show, Switch, createMemo, type Accessor } from "solid-js";
import type { ModelDescriptor } from "../../agent/model-client.js";
import type { HistoryViewItem } from "../../commands/types.js";
import type { ThreadDiffFacts } from "../../revisions/diff-service.js";
import type { UiScreen, UiState } from "../state.js";
import { short } from "./controller.js";
import type { ThreadViewResources } from "./resources.js";
import { wheelScrollAcceleration } from "./scroll.js";
import { normalizeMarkdownForTerminal } from "./transcript.js";
import { bold } from "./theme.js";
import { useTerminalDimensions } from "@opentui/solid";

const HISTORY_MAX_VISIBLE = 18;

export function selectedWindow<T>(items: readonly T[], selected: number, visible: number): Array<{ item: T; index: number }> {
  const count = Math.min(visible, items.length);
  const start = Math.max(0, Math.min(selected - Math.floor(count / 2), items.length - count));
  return items.slice(start, start + count).map((item, offset) => ({ item, index: start + offset }));
}

function visibleRows(height: number, reserved: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, height - reserved));
}

function ScreenHeader(props: { left: string; center?: string; right: string; resources: ThreadViewResources }) {
  return (
    <box flexDirection="column" width="100%" border={["bottom"]} borderColor={props.resources.theme.border}>
      <box flexDirection="row" justifyContent="space-between" width="100%" paddingX={1}>
        <text height={1} wrapMode="none" fg={props.resources.theme.text} attributes={bold} truncate={true}>{props.left}</text>
        <text height={1} wrapMode="none" fg={props.resources.theme.accent} truncate={true}>{props.center ?? ""}</text>
        <text height={1} wrapMode="none" fg={props.resources.theme.muted} truncate={true}>{props.right}</text>
      </box>
    </box>
  );
}

function ScreenFooter(props: { hint: string; state: Accessor<UiState>; resources: ThreadViewResources }) {
  return (
    <box flexDirection="row" width="100%" height={1} paddingX={1}>
      <text flexGrow={1} height={1} wrapMode="none" truncate={true} fg={props.resources.theme.accent}>{props.hint}</text>
      <text height={1} wrapMode="none" truncate={true} fg={props.resources.theme.success}>
        {props.state().branch} @ {short(props.state().checkpointId)}
      </text>
    </box>
  );
}

export function modelDetail(model: ModelDescriptor): string {
  return [
    model.name !== model.modelId ? model.name : undefined,
    `${model.contextWindow.toLocaleString("en-US")} ctx`,
    model.reasoning ? "reasoning" : undefined,
  ].filter((value): value is string => value !== undefined).join(" · ");
}

function SectionTitle(props: { children: string; resources: ThreadViewResources }) {
  return <text fg={props.resources.theme.accent} attributes={bold} marginTop={1}>{props.children.toUpperCase()}</text>;
}

function WorkspaceFacts(props: { facts: ThreadDiffFacts; resources: ThreadViewResources }) {
  return (
    <box flexDirection="column">
      <SectionTitle resources={props.resources}>Workspace</SectionTitle>
      <Show when={props.facts.workspace.files.length > 0} fallback={<text fg={props.resources.theme.muted}>No workspace changes</text>}>
        <For each={props.facts.workspace.files}>
          {(file) => {
            const filePath = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
            const status = file.status === "added" ? "A" : file.status === "deleted" ? "D" : file.status === "renamed" ? "R" : "M";
            const color = file.status === "added" ? props.resources.theme.diffAdded : file.status === "deleted" ? props.resources.theme.diffRemoved : props.resources.theme.warning;
            return <text fg={color}>{status}  {filePath}  {file.binary ? "binary" : `+${file.additions ?? 0} -${file.deletions ?? 0}`}</text>;
          }}
        </For>
      </Show>
    </box>
  );
}

function ContextFacts(props: { facts: ThreadDiffFacts; resources: ThreadViewResources }) {
  const context = () => props.facts.context;
  return (
    <box flexDirection="column">
      <SectionTitle resources={props.resources}>Context</SectionTitle>
      <text fg={props.resources.theme.success}>+ {context().toOnly.count} entries on target version</text>
      <text fg={props.resources.theme.error}>− {context().fromOnly.count} entries only on source version</text>
      <text fg={props.resources.theme.softText}>{context().userMessageCount} user · {context().assistantMessageCount} assistant messages</text>
      <text fg={props.resources.theme.softText}>{context().toolCallCount} tool calls · {context().compactionCount} compactions</text>
    </box>
  );
}

export function DiffScreen(props: {
  screen: () => Extract<UiScreen, { type: "diff" }>;
  state: Accessor<UiState>;
  resources: ThreadViewResources;
  setScroll: (value: ScrollBoxRenderable) => void;
}) {
  const facts = () => props.screen().result.facts;
  return (
    <>
      <ScreenHeader
        left="THREAD DIFF"
        center={`${facts().from.ref} → ${facts().to.ref}`}
        right={["summary", "context", "workspace"].map((tab) => tab === props.screen().tab ? `[${tab}]` : tab).join("  ")}
        resources={props.resources}
      />
      <scrollbox
        ref={props.setScroll}
        flexGrow={1}
        viewportCulling={true}
        scrollAcceleration={wheelScrollAcceleration}
        verticalScrollbarOptions={{ visible: false }}
        paddingX={2}
      >
        <Switch>
          <Match when={props.screen().tab === "summary"}>
            <SectionTitle resources={props.resources}>What changed</SectionTitle>
            <markdown
              content={normalizeMarkdownForTerminal(props.screen().result.semantic ?? `Semantic summary unavailable: ${props.screen().result.semanticError ?? "not requested"}`)}
              width="100%"
              syntaxStyle={props.resources.syntaxStyle}
              fg={props.resources.theme.text}
              conceal={true}
              internalBlockMode="top-level"
            />
            <ContextFacts facts={facts()} resources={props.resources} />
            <WorkspaceFacts facts={facts()} resources={props.resources} />
          </Match>
          <Match when={props.screen().tab === "context"}>
            <ContextFacts facts={facts()} resources={props.resources} />
            <text fg={props.resources.theme.muted} wrapMode="char">{JSON.stringify(facts().context, null, 2)}</text>
          </Match>
          <Match when={props.screen().tab === "workspace"}><WorkspaceFacts facts={facts()} resources={props.resources} /></Match>
        </Switch>
      </scrollbox>
      <ScreenFooter hint="tab / 1-3 section · ↑/↓ scroll · esc back" state={props.state} resources={props.resources} />
    </>
  );
}

export function MergeScreen(props: {
  screen: () => Extract<UiScreen, { type: "merge" }>;
  state: Accessor<UiState>;
  resources: ThreadViewResources;
  setScroll: (value: ScrollBoxRenderable) => void;
}) {
  const screen = props.screen;
  return (
    <>
      <ScreenHeader left="THREAD MERGE" center={`${screen().preview.incomingLabel} → ${screen().preview.currentBranch}`} right="preview · nothing applied yet" resources={props.resources} />
      <scrollbox
        ref={props.setScroll}
        flexGrow={1}
        viewportCulling={true}
        scrollAcceleration={wheelScrollAcceleration}
        verticalScrollbarOptions={{ visible: false }}
        paddingX={2}
      >
        <SectionTitle resources={props.resources}>1  Workspace merge</SectionTitle>
        <text fg={screen().preview.clean ? props.resources.theme.success : props.resources.theme.error} attributes={bold}>
          {screen().preview.clean
            ? `READY  ${screen().preview.workspaceFiles.length} files can auto-merge`
            : `BLOCKED  ${screen().preview.conflicts.length} workspace conflict(s)`}
        </text>
        <For each={screen().preview.workspaceFiles}>{(file) => <text fg={props.resources.theme.softText}>{file.status.slice(0, 1).toUpperCase()}  {file.path}</text>}</For>
        <For each={screen().preview.conflicts}>{(conflict) => <text fg={props.resources.theme.error}>!  {conflict}</text>}</For>
        <SectionTitle resources={props.resources}>2  Context strategy</SectionTitle>
        <text fg={screen().selected === "keep-current" ? props.resources.theme.accentStrong : props.resources.theme.text}>
          {screen().selected === "keep-current" ? "◉" : "○"} Keep current context
        </text>
        <text fg={props.resources.theme.muted} marginLeft={3}>Discard incoming conversation; current branch continues unchanged.</text>
        <text fg={screen().selected === "summarize" ? props.resources.theme.accentStrong : props.resources.theme.text}>
          {screen().selected === "summarize" ? "◉" : "○"} Import useful context with model
        </text>
        <text fg={props.resources.theme.muted} marginLeft={3}>Generate a concise handoff note; do not splice chat histories.</text>
        <Show when={screen().note}>
          <SectionTitle resources={props.resources}>Handoff preview</SectionTitle>
          <markdown content={normalizeMarkdownForTerminal(screen().note ?? "")} width="100%" syntaxStyle={props.resources.syntaxStyle} fg={props.resources.theme.text} conceal={true} />
        </Show>
        <Show when={screen().error}><text fg={props.resources.theme.error}>{screen().error}</text></Show>
        <text fg={screen().confirm ? props.resources.theme.warning : props.resources.theme.success} marginTop={1}>
          {screen().busy ? "● Preparing merge…" : screen().confirm ? "Press enter again to apply; esc cancels." : "Preview ready. Press enter to continue."}
        </text>
      </scrollbox>
      <ScreenFooter hint="↑/↓ strategy · PgUp/PgDn scroll · enter continue · esc cancel" state={props.state} resources={props.resources} />
    </>
  );
}

function historyLine(item: HistoryViewItem): string {
  return `${short(item.turnId)}  ${item.outcome.padEnd(9)}  ${new Date(item.startedAt).toLocaleString()}  ${item.label}`;
}

export function HistoryScreen(props: {
  screen: () => Extract<UiScreen, { type: "history" }>;
  state: Accessor<UiState>;
  resources: ThreadViewResources;
}) {
  const dimensions = useTerminalDimensions();
  const rowCount = createMemo(() => visibleRows(
    dimensions().height,
    8 + Number(props.screen().confirm) + Number(props.screen().busy) + Number(Boolean(props.screen().error)),
    HISTORY_MAX_VISIBLE,
  ));
  const visible = createMemo(() => selectedWindow(props.screen().items, props.screen().selected, rowCount()));
  const first = () => visible()[0]?.index ?? 0;
  const last = () => visible().at(-1)?.index ?? -1;
  return (
    <>
      <ScreenHeader
        left="SESSION HISTORY"
        center={props.state().branch}
        right={`${props.screen().items.length > 0 ? props.screen().selected + 1 : 0} / ${props.screen().items.length}`}
        resources={props.resources}
      />
      <box flexDirection="column" flexGrow={1} paddingX={2} paddingTop={1}>
        <text height={1} wrapMode="none" truncate={true} fg={props.resources.theme.muted}>Restore returns workspace and context to immediately before the selected message.</text>
        <Show when={first() > 0}><text height={1} wrapMode="none" fg={props.resources.theme.muted}>↑ {first()} earlier turn(s)</text></Show>
        <For each={visible()}>
          {({ item, index }) => {
            const selected = () => index === props.screen().selected;
            return (
              <text
                fg={selected() ? props.resources.theme.selectionText : props.resources.theme.text}
                bg={selected() ? props.resources.theme.selection : "transparent"}
                height={1}
                wrapMode="none"
                truncate={true}
              >
                {selected() ? "→" : " "} {historyLine(item)}
              </text>
            );
          }}
        </For>
        <Show when={last() + 1 < props.screen().items.length}>
          <text height={1} wrapMode="none" fg={props.resources.theme.muted}>↓ {props.screen().items.length - last() - 1} later turn(s)</text>
        </Show>
        <Show when={props.screen().confirm && props.screen().items[props.screen().selected]}>
          <text fg={props.resources.theme.warning} marginTop={1}>
            Restore to checkpoint {short(props.screen().items[props.screen().selected]!.baseCheckpointId)}? Press enter again.
          </text>
        </Show>
        <Show when={props.screen().busy}><text fg={props.resources.theme.accent}>Restoring…</text></Show>
        <Show when={props.screen().error}><text fg={props.resources.theme.error}>{props.screen().error}</text></Show>
      </box>
      <ScreenFooter hint="↑/↓ select · enter restore · esc cancel" state={props.state} resources={props.resources} />
    </>
  );
}

export function DocumentScreen(props: {
  screen: () => Extract<UiScreen, { type: "document" }>;
  state: Accessor<UiState>;
  resources: ThreadViewResources;
  setScroll: (value: ScrollBoxRenderable) => void;
}) {
  return (
    <>
      <ScreenHeader left={props.screen().title.toUpperCase()} right="ephemeral · not in session" resources={props.resources} />
      <scrollbox
        ref={props.setScroll}
        flexGrow={1}
        viewportCulling={true}
        scrollAcceleration={wheelScrollAcceleration}
        verticalScrollbarOptions={{ visible: false }}
        paddingX={2}
        paddingY={1}
      >
        <markdown
          content={normalizeMarkdownForTerminal(props.screen().content)}
          width="100%"
          syntaxStyle={props.resources.syntaxStyle}
          fg={props.resources.theme.text}
          conceal={true}
          internalBlockMode="top-level"
        />
      </scrollbox>
      <ScreenFooter hint="↑/↓ scroll · esc back" state={props.state} resources={props.resources} />
    </>
  );
}
