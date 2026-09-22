import type { KeyBinding, ScrollBoxRenderable } from "@opentui/core";
import { createSignal, Show, type Accessor } from "solid-js";
import { isSlashCommandInput } from "../../app/input-router.js";
import type { LiveTurn, TranscriptItem, UiState } from "../state.js";
import type { ComposerImage } from "../images.js";
import type { ComposerSuggestion } from "./completion.js";
import type { ComposerDraft } from "./composer-state.js";
import type { TerminalMeta, ThreadTuiViewModel } from "./view-model.js";
import type { ThreadViewResources } from "./resources.js";
import { wheelScrollAcceleration } from "./scroll.js";
import { TranscriptTurnsView, WelcomeView } from "./transcript.js";
import { ComposerSuggestions, overlayHeight, SessionOverlay } from "./session-overlays.js";
import { Footer, Status } from "./session-status.js";
import { bold } from "./theme.js";
import { Line, Row } from "./widgets.js";

const COMPOSER_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
];
export const COMPOSER_MIN_LINES = 1;
export const COMPOSER_MAX_LINES = 4;

function attachmentSummary(images: readonly ComposerImage[], busy: boolean): string {
  if (!images.length) return busy ? "reading clipboard…" : "";
  const details = images.map((image) => `${image.width}×${image.height} ${image.mimeType.replace(/^image\//, "")}`);
  return `${images.length === 1 ? "image" : `${images.length} images`} · ${details.join(" · ")}${busy ? " · reading clipboard…" : ""}`;
}

export function estimatedWrappedLines(text: string, width: number, maximum = Number.POSITIVE_INFINITY): number {
  if (!text) return 0;
  let lines = 0;
  for (const line of text.split("\n")) {
    lines += Math.max(1, Math.ceil([...line].length / Math.max(1, width)));
    if (lines >= maximum) return maximum;
  }
  return lines;
}

export function SessionScreen(props: {
  controller: ThreadTuiViewModel;
  state: Accessor<UiState>;
  transcript: Accessor<readonly TranscriptItem[]>;
  liveTurn: Accessor<LiveTurn | undefined>;
  meta: Accessor<TerminalMeta>;
  resources: ThreadViewResources;
  draft: ComposerDraft;
  suggestions: () => readonly ComposerSuggestion[];
  suggestionIndex: () => number;
  overlaySelected: Accessor<number>;
  overlayNavigated: Accessor<boolean>;
  composerHeight: Accessor<number>;
  terminalWidth: Accessor<number>;
  setScroll: (value: ScrollBoxRenderable) => void;
}) {
  const state = props.state;
  const draft = props.draft;
  const theme = props.resources.theme;
  const [scroll, setScroll] = createSignal<ScrollBoxRenderable>();
  const hasAttachments = () => draft.attachments().length > 0 || draft.busy();
  // Status + bordered composer + optional attachment row + footer.
  const controlsHeight = () => props.composerHeight() + 4 + Number(hasAttachments());
  const hasTranscript = () => props.transcript().length > 0 || props.liveTurn() !== undefined;
  const contentWidth = () => Math.max(20, props.terminalWidth() - 4);
  const panelHeight = () => overlayHeight(state().screen);
  const floatingHeight = () => panelHeight() || (state().screen.type === "session" && props.suggestions().length
    ? props.suggestions().length + 2 : 0);
  const syncCursor = () => {
    draft.setCursor(draft.editor?.cursorOffset ?? 0);
    draft.setForcePaths(false);
  };
  const submit = () => {
    const editor = draft.editor;
    if (!editor || state().busy) return;
    if (draft.busy()) {
      props.controller.note("Wait for the clipboard image to finish processing.", "info");
      return;
    }
    const input = editor.plainText;
    const images = [...draft.attachments()];
    const command = isSlashCommandInput(input);
    if (images.length && !command && !props.controller.meta.acceptsImages) {
      props.controller.note("Current model does not accept images. Use /model to pick a vision model.", "error");
      return;
    }
    editor.clear();
    draft.replace("");
    if (!command) draft.setAttachments([]);
    void props.controller.submit(input, command ? [] : images);
  };
  return <box position="relative" width="100%" height="100%" backgroundColor={theme.background}>
    <Show when={hasTranscript()} fallback={
      <box position="absolute" top={0} right={0} bottom={controlsHeight()} left={0}>
        <WelcomeView resources={props.resources} />
      </box>
    }>
      <scrollbox ref={(value) => { setScroll(value); props.setScroll(value); }} position="absolute" top={0} right={0} bottom={controlsHeight()} left={0}
        stickyScroll={true} stickyStart="bottom" viewportCulling={true} scrollAcceleration={wheelScrollAcceleration}
        verticalScrollbarOptions={{ visible: false }} paddingTop={1}>
        <Show when={state().sessionId} keyed>
          {() => <TranscriptTurnsView items={props.transcript()} liveTurn={props.liveTurn()} resources={props.resources} scroll={scroll} />}
        </Show>
      </scrollbox>
    </Show>
    <Show when={floatingHeight()}>
      <box position="absolute" right={1} bottom={controlsHeight()} left={1} height={floatingHeight()} zIndex={20}
        border={true} borderStyle="rounded" borderColor={state().screen.type === "ask" ? theme.spark : theme.borderStrong}
        backgroundColor={theme.surface}>
        <Show when={panelHeight()} fallback={
          <ComposerSuggestions suggestions={props.suggestions()} selected={props.suggestionIndex()} resources={props.resources} contentWidth={contentWidth} />
        }>
          <SessionOverlay screen={() => state().screen} selected={props.overlaySelected} navigated={props.overlayNavigated}
            resources={props.resources} contentWidth={contentWidth} />
        </Show>
      </box>
    </Show>
    <box position="absolute" right={0} bottom={0} left={0} height={controlsHeight()} zIndex={30}
      flexDirection="column" backgroundColor={theme.background}>
      <box flexShrink={0} width="100%"><Status state={props.state} resources={props.resources} /></box>
      <box flexShrink={0} flexDirection="column" marginX={1} border={true} borderStyle="rounded"
        borderColor={state().busy ? theme.spark : theme.borderStrong} backgroundColor={theme.surfaceHigh}>
        <Show when={hasAttachments()}>
          <Row width="100%" paddingLeft={1} paddingRight={1}>
            <Line flexGrow={1} fg={theme.muted}>{attachmentSummary(draft.attachments(), draft.busy())}</Line>
          </Row>
        </Show>
        <box flexDirection="row" width="100%" paddingLeft={1}>
          <Line width={2} fg={theme.accent} attributes={bold}>❯</Line>
          <textarea ref={draft.setEditor} flexGrow={1} height={props.composerHeight()}
            minHeight={COMPOSER_MIN_LINES} maxHeight={COMPOSER_MAX_LINES} wrapMode="word"
            placeholder="ask thread, / commands, @ files, Ctrl+V paste…" placeholderColor={theme.muted}
            textColor={theme.text} focusedTextColor={theme.text} backgroundColor={theme.surfaceHigh}
            focusedBackgroundColor={theme.surfaceHigh} cursorColor={theme.spark} selectionBg={theme.selection}
            selectionFg={theme.selectionText} keyBindings={COMPOSER_KEY_BINDINGS}
            onContentChange={() => { draft.setText(draft.editor?.plainText ?? ""); syncCursor(); }}
            onCursorChange={syncCursor} onSubmit={submit} />
        </box>
      </box>
      <box flexShrink={0} width="100%">
        <Footer state={props.state} meta={props.meta} resources={props.resources} width={props.terminalWidth} />
      </box>
    </box>
  </box>;
}
