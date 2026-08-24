import type { KeyBinding, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { For, Show, type Accessor } from "solid-js";
import type { LiveTurn, UiState } from "../state.js";
import type { ComposerSuggestion } from "./completion.js";
import { short, type TerminalMeta, type ThreadTuiViewModel } from "./controller.js";
import type { ThreadViewResources } from "./resources.js";
import { LiveTurnView, TranscriptItemView, WelcomeView } from "./transcript.js";
import { bold } from "./theme.js";

const SESSION_FOOTER_HEIGHT = 5;
const COMPOSER_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
];

export function estimatedWrappedLines(text: string, width: number, maximum = Number.POSITIVE_INFINITY): number {
  if (!text) return 0;
  const columns = Math.max(1, width);
  let lines = 0;
  for (const line of text.split("\n")) {
    lines += Math.max(1, Math.ceil([...line].length / columns));
    if (lines >= maximum) return maximum;
  }
  return Math.min(lines, maximum);
}

function Footer(props: {
  state: Accessor<UiState>;
  meta: Accessor<TerminalMeta>;
  resources: ThreadViewResources;
  width: Accessor<number>;
}) {
  const state = props.state;
  const meta = props.meta;
  const model = () => meta().supportsThinking
    ? `${meta().modelLabel} · ${meta().thinkingLevel}`
    : meta().modelLabel;
  const compact = () => props.width() < 72;
  const narrow = () => props.width() < 96;
  const left = () => {
    const base = `${state().branch} · ${short(state().checkpointId)}`;
    return !narrow() && meta().uncommitted ? `${base} · dirty` : base;
  };
  return (
    <box flexDirection="row" width="100%" height={1} paddingX={1}>
      <text width={compact() ? "38%" : narrow() ? "34%" : "42%"} height={1} wrapMode="none" fg={props.resources.theme.muted} truncate={true}>
        {left()}
      </text>
      <Show when={!compact()}>
        <text width="14%" height={1} wrapMode="none" fg={props.resources.theme.muted} truncate={true}> ctx {meta().contextPercent}%</text>
      </Show>
      <text flexGrow={1} height={1} wrapMode="none" fg={props.resources.theme.accent} truncate={true}> {model()}</text>
    </box>
  );
}

function Status(props: { state: Accessor<UiState>; resources: ThreadViewResources }) {
  const state = props.state;
  const color = () => state().busy
    ? props.resources.theme.accentStrong
    : state().notice?.level === "error"
      ? props.resources.theme.error
      : state().notice?.level === "success"
        ? props.resources.theme.success
        : props.resources.theme.accent;
  const text = () => state().busy
    ? `${state().activity ?? "working"}  ·  esc interrupt`
    : state().notice?.text ?? "";
  return <text height={1} wrapMode="none" fg={color()} truncate={true} paddingX={1}>{text()}</text>;
}

function ComposerSuggestions(props: {
  suggestions: readonly ComposerSuggestion[];
  selected: number;
  resources: ThreadViewResources;
}) {
  return (
    <box flexDirection="column" width="100%" paddingX={1} backgroundColor={props.resources.theme.background}>
      <For each={props.suggestions}>
        {(suggestion, index) => (
          <box
            flexDirection="row"
            width="100%"
            height={1}
            backgroundColor={index() === props.selected ? props.resources.theme.selection : "transparent"}
          >
            <text
              width={18}
              height={1}
              wrapMode="none"
              truncate={true}
              fg={index() === props.selected ? props.resources.theme.selectionText : props.resources.theme.text}
              attributes={index() === props.selected ? bold : 0}
            >
              {suggestion.label}
            </text>
            <text
              flexGrow={1}
              height={1}
              wrapMode="none"
              fg={index() === props.selected ? props.resources.theme.selectionText : props.resources.theme.muted}
              truncate={true}
            >
              {suggestion.description}
            </text>
          </box>
        )}
      </For>
    </box>
  );
}

export function SessionScreen(props: {
  controller: ThreadTuiViewModel;
  state: Accessor<UiState>;
  meta: Accessor<TerminalMeta>;
  resources: ThreadViewResources;
  composer: () => TextareaRenderable | undefined;
  setComposer: (value: TextareaRenderable) => void;
  composerText: () => string;
  setComposerText: (value: string) => void;
  setComposerCursor: (value: number) => void;
  setForcePathCompletion: (value: boolean) => void;
  suggestions: () => readonly ComposerSuggestion[];
  suggestionIndex: () => number;
  composerHeight: Accessor<number>;
  terminalWidth: Accessor<number>;
  setScroll: (value: ScrollBoxRenderable) => void;
}) {
  const state = props.state;
  const controlsHeight = () => props.composerHeight() + 3;
  return (
    <box position="relative" width="100%" height="100%" backgroundColor={props.resources.theme.background}>
      <scrollbox
        ref={props.setScroll}
        position="absolute"
        top={0}
        right={0}
        bottom={SESSION_FOOTER_HEIGHT}
        left={0}
        stickyScroll={true}
        stickyStart="bottom"
        viewportCulling={true}
        verticalScrollbarOptions={{ visible: false }}
      >
        <Show when={state().transcript.length > 0 || state().liveTurn} fallback={<WelcomeView resources={props.resources} />}>
          <For each={state().transcript}>
            {(item) => <TranscriptItemView item={item} resources={props.resources} />}
          </For>
          <Show when={state().liveTurn}>
            {(live: Accessor<LiveTurn>) => <LiveTurnView turn={live} resources={props.resources} />}
          </Show>
        </Show>
      </scrollbox>
      <Show when={props.suggestions().length > 0}>
        <box
          position="absolute"
          right={1}
          bottom={controlsHeight()}
          left={1}
          height={props.suggestions().length}
          zIndex={20}
          backgroundColor={props.resources.theme.surface}
        >
          <ComposerSuggestions
            suggestions={props.suggestions()}
            selected={props.suggestionIndex()}
            resources={props.resources}
          />
        </box>
      </Show>
      <box
        position="absolute"
        right={0}
        bottom={0}
        left={0}
        height={controlsHeight()}
        zIndex={30}
        flexDirection="column"
        backgroundColor={props.resources.theme.background}
      >
        <box flexShrink={0} width="100%"><Status state={props.state} resources={props.resources} /></box>
        <box flexShrink={0} border={["top"]} borderColor={state().busy ? props.resources.theme.accent : props.resources.theme.border}>
          <textarea
            ref={props.setComposer}
            height={props.composerHeight()}
            minHeight={2}
            maxHeight={6}
            paddingX={1}
            wrapMode="word"
            placeholder="ask thread…"
            placeholderColor={props.resources.theme.muted}
            textColor={props.resources.theme.text}
            focusedTextColor={props.resources.theme.text}
            backgroundColor={props.resources.theme.background}
            focusedBackgroundColor={props.resources.theme.background}
            cursorColor={props.resources.theme.accentStrong}
            selectionBg={props.resources.theme.selection}
            selectionFg={props.resources.theme.selectionText}
            keyBindings={COMPOSER_KEY_BINDINGS}
            onContentChange={() => {
              const editor = props.composer();
              props.setComposerText(editor?.plainText ?? "");
              props.setComposerCursor(editor?.cursorOffset ?? 0);
              props.setForcePathCompletion(false);
            }}
            onCursorChange={() => {
              const editor = props.composer();
              props.setComposerCursor(editor?.cursorOffset ?? 0);
              props.setForcePathCompletion(false);
            }}
            onSubmit={() => {
              const editor = props.composer();
              if (!editor || state().busy) return;
              const input = editor.plainText;
              editor.clear();
              props.setComposerText("");
              props.setComposerCursor(0);
              props.setForcePathCompletion(false);
              void props.controller.submit(input);
            }}
          />
        </box>
        <box flexShrink={0} width="100%">
          <Footer state={props.state} meta={props.meta} resources={props.resources} width={props.terminalWidth} />
        </box>
      </box>
    </box>
  );
}
