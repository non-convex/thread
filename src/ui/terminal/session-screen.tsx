import type { KeyBinding, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { Show, type Accessor } from "solid-js";
import { isSlashCommandInput } from "../../app/input-router.js";
import { filteredModels, type AgentPickerScreen, type AgentSettingsScreen, type AskScreen, type CommandPickerScreen, type LiveTurn, type ModelPickerScreen, type RewindScreen, type TranscriptItem, type UiState } from "../state.js";
import type { ComposerImage } from "../images.js";
import type { ComposerSuggestion } from "./completion.js";
import type { TerminalMeta, ThreadTuiViewModel } from "./view-model.js";
import type { ThreadViewResources } from "./resources.js";
import { wheelScrollAcceleration } from "./scroll.js";
import { LiveTurnView, TranscriptTurnsView, WelcomeView } from "./transcript.js";
import { AgentPickerOverlay, AgentSettingsOverlay, ModelPickerOverlay, MODEL_OVERLAY_MAX_ROWS } from "./agent-overlays.js";
import { AskOverlay, CommandPickerOverlay, ComposerSuggestions, RewindOverlay, ASK_OVERLAY_MAX_OPTIONS, COMMAND_OVERLAY_MAX_ITEMS, REWIND_OVERLAY_MAX_ROWS } from "./session-overlays.js";
import { Footer, Status } from "./session-status.js";
import { bold } from "./theme.js";

const COMPOSER_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "linefeed", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
];

/** Textarea rows: one line minimum, four before the transcript starts scrolling. */
export const COMPOSER_MIN_LINES = 1;
export const COMPOSER_MAX_LINES = 4;

function attachmentSummary(images: readonly ComposerImage[], busy: boolean): string {
  if (images.length === 0) return busy ? "reading clipboard…" : "";
  const details = images.map((image) => {
    const kind = image.mimeType.replace(/^image\//, "");
    return `${image.width}×${image.height} ${kind}`;
  });
  const prefix = images.length === 1 ? "image" : `${images.length} images`;
  return `${prefix} · ${details.join(" · ")}${busy ? " · reading clipboard…" : ""}`;
}

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

export function SessionScreen(props: {
  controller: ThreadTuiViewModel;
  state: Accessor<UiState>;
  transcript: Accessor<readonly TranscriptItem[]>;
  liveTurn: Accessor<LiveTurn | undefined>;
  meta: Accessor<TerminalMeta>;
  resources: ThreadViewResources;
  composer: () => TextareaRenderable | undefined;
  setComposer: (value: TextareaRenderable) => void;
  setComposerText: (value: string) => void;
  setComposerCursor: (value: number) => void;
  setForcePathCompletion: (value: boolean) => void;
  suggestions: () => readonly ComposerSuggestion[];
  suggestionIndex: () => number;
  /** View-side selection shared by the floating picker panels. */
  overlaySelected: Accessor<number>;
  /** True between an overlay arrow-key move and the next controller notify. */
  overlayNavigated: Accessor<boolean>;
  composerHeight: Accessor<number>;
  terminalWidth: Accessor<number>;
  attachments: Accessor<readonly ComposerImage[]>;
  setAttachments: (images: ComposerImage[]) => void;
  pasteBusy: Accessor<boolean>;
  setScroll: (value: ScrollBoxRenderable) => void;
}) {
  const state = props.state;
  const theme = props.resources.theme;
  const attachmentLine = () => props.attachments().length > 0 || props.pasteBusy() ? 1 : 0;
  // status line + composer (border + textarea row + optional attachment row) + footer
  const controlsHeight = () => props.composerHeight() + 4 + attachmentLine();
  const hasTranscript = () => props.transcript().length > 0 || props.liveTurn() !== undefined;
  const commandPicker = (): CommandPickerScreen | undefined =>
    state().screen.type === "command_picker" ? state().screen as CommandPickerScreen : undefined;
  const modelPicker = (): ModelPickerScreen | undefined =>
    state().screen.type === "model_picker" ? state().screen as ModelPickerScreen : undefined;
  const agentPicker = (): AgentPickerScreen | undefined =>
    state().screen.type === "agent_picker" ? state().screen as AgentPickerScreen : undefined;
  const agentSettings = (): AgentSettingsScreen | undefined =>
    state().screen.type === "agent_settings" ? state().screen as AgentSettingsScreen : undefined;
  const rewindScreen = (): RewindScreen | undefined =>
    state().screen.type === "rewind" ? state().screen as RewindScreen : undefined;
  /* Floating panels sit at left/right 1 with a rounded border, so their
   * interior width is the terminal width minus margins and the two border
   * columns. */
  const overlayContentWidth = () => Math.max(20, props.terminalWidth() - 4);
  const commandOverlayHeight = () => {
    const picker = commandPicker();
    if (!picker) return 0;
    return 2 + Math.max(1, Math.min(COMMAND_OVERLAY_MAX_ITEMS, picker.items.length) * 2)
      + (picker.busy ? 1 : 0) + (picker.error ? 1 : 0) + 2;
  };
  const modelOverlayHeight = () => {
    const picker = modelPicker();
    if (!picker) return 0;
    // Header + margin, filter, model rows, scope action, status, and border.
    return 2 + 1 + Math.max(1, Math.min(MODEL_OVERLAY_MAX_ROWS, filteredModels(picker).length)) + 1
      + (picker.busy ? 1 : 0) + (picker.error ? 1 : 0) + 2;
  };
  const agentPickerOverlayHeight = () => {
    const picker = agentPicker();
    if (!picker) return 0;
    return 2 + picker.agents.length + (picker.busy ? 1 : 0) + (picker.error ? 1 : 0) + 2;
  };
  const agentSettingsOverlayHeight = () => {
    const settings = agentSettings();
    if (!settings) return 0;
    return 2 + 3 + (settings.busy ? 1 : 0) + (settings.error ? 1 : 0) + 2;
  };
  const rewindOverlayHeight = () => {
    const rewind = rewindScreen();
    if (!rewind) return 0;
    // header + windowed rows + optional confirm/busy/error lines + border
    return 2 + Math.min(REWIND_OVERLAY_MAX_ROWS, rewind.items.length)
      + (rewind.confirm ? 1 : 0)
      + (rewind.busy ? 1 : 0) + (rewind.error ? 1 : 0) + 2;
  };
  const askScreen = (): AskScreen | undefined =>
    state().screen.type === "ask" ? state().screen as AskScreen : undefined;
  const askOverlayHeight = () => {
    const ask = askScreen();
    if (!ask) return 0;
    const question = ask.request.questions[ask.questionIndex];
    // header + question text + (options + hint | one input row) + border
    const body = ask.customText !== undefined
      ? 1
      : Math.min(ASK_OVERLAY_MAX_OPTIONS, question?.options.length ?? 0) + 1;
    return 2 + body + 2;
  };
  return (
    <box position="relative" width="100%" height="100%" backgroundColor={theme.background}>
      <Show
        when={hasTranscript()}
        fallback={
          <box position="absolute" top={0} right={0} bottom={controlsHeight()} left={0}>
            <WelcomeView resources={props.resources} />
          </box>
        }
      >
        <scrollbox
          ref={props.setScroll}
          position="absolute"
          top={0}
          right={0}
          bottom={controlsHeight()}
          left={0}
          stickyScroll={true}
          stickyStart="bottom"
          viewportCulling={true}
          scrollAcceleration={wheelScrollAcceleration}
          verticalScrollbarOptions={{ visible: false }}
          paddingTop={1}
        >
          <TranscriptTurnsView items={props.transcript()} resources={props.resources} />
          <Show when={props.liveTurn()}>
            {(live: Accessor<LiveTurn>) => (
              <LiveTurnView turn={live} label="thread" resources={props.resources} />
            )}
          </Show>
        </scrollbox>
      </Show>
      <Show when={state().screen.type === "session" && props.suggestions().length > 0}>
        <box
          position="absolute"
          right={1}
          bottom={controlsHeight()}
          left={1}
          height={props.suggestions().length + 2}
          zIndex={20}
          border={true}
          borderStyle="rounded"
          borderColor={theme.borderStrong}
          backgroundColor={theme.surface}
        >
          <ComposerSuggestions
            suggestions={props.suggestions()}
            selected={props.suggestionIndex()}
            resources={props.resources}
            contentWidth={overlayContentWidth}
          />
        </box>
      </Show>
      {/* Do NOT use Show's callback form here: the controller mutates the
          picker screen in place, so the object reference never changes and a
          Show-scoped accessor would freeze the selection highlight. */}
      <Show when={commandPicker() !== undefined}>
        <box
          position="absolute"
          right={1}
          bottom={controlsHeight()}
          left={1}
          height={commandOverlayHeight()}
          zIndex={20}
          border={true}
          borderStyle="rounded"
          borderColor={theme.borderStrong}
          backgroundColor={theme.surface}
        >
          <CommandPickerOverlay
            screen={() => commandPicker() as CommandPickerScreen}
            selected={props.overlaySelected}
            navigated={props.overlayNavigated}
            resources={props.resources}
            contentWidth={overlayContentWidth}
          />
        </box>
      </Show>
      <Show when={agentPicker() !== undefined}>
        <box
          position="absolute"
          right={1}
          bottom={controlsHeight()}
          left={1}
          height={agentPickerOverlayHeight()}
          zIndex={20}
          border={true}
          borderStyle="rounded"
          borderColor={theme.borderStrong}
          backgroundColor={theme.surface}
        >
          <AgentPickerOverlay
            screen={() => agentPicker() as AgentPickerScreen}
            selected={props.overlaySelected}
            navigated={props.overlayNavigated}
            resources={props.resources}
            contentWidth={overlayContentWidth}
          />
        </box>
      </Show>
      <Show when={modelPicker() !== undefined}>
        <box
          position="absolute"
          right={1}
          bottom={controlsHeight()}
          left={1}
          height={modelOverlayHeight()}
          zIndex={20}
          border={true}
          borderStyle="rounded"
          borderColor={theme.borderStrong}
          backgroundColor={theme.surface}
        >
          <ModelPickerOverlay
            screen={() => modelPicker() as ModelPickerScreen}
            selected={props.overlaySelected}
            navigated={props.overlayNavigated}
            resources={props.resources}
            contentWidth={overlayContentWidth}
          />
        </box>
      </Show>
      <Show when={agentSettings() !== undefined}>
        <box
          position="absolute"
          right={1}
          bottom={controlsHeight()}
          left={1}
          height={agentSettingsOverlayHeight()}
          zIndex={20}
          border={true}
          borderStyle="rounded"
          borderColor={theme.borderStrong}
          backgroundColor={theme.surface}
        >
          <AgentSettingsOverlay
            screen={() => agentSettings() as AgentSettingsScreen}
            selected={props.overlaySelected}
            resources={props.resources}
            contentWidth={overlayContentWidth}
          />
        </box>
      </Show>
      <Show when={rewindScreen() !== undefined}>
        <box
          position="absolute"
          right={1}
          bottom={controlsHeight()}
          left={1}
          height={rewindOverlayHeight()}
          zIndex={20}
          border={true}
          borderStyle="rounded"
          borderColor={theme.borderStrong}
          backgroundColor={theme.surface}
        >
          <RewindOverlay
            screen={() => rewindScreen() as RewindScreen}
            selected={props.overlaySelected}
            navigated={props.overlayNavigated}
            resources={props.resources}
            contentWidth={overlayContentWidth}
          />
        </box>
      </Show>
      <Show when={askScreen() !== undefined}>
        <box
          position="absolute"
          right={1}
          bottom={controlsHeight()}
          left={1}
          height={askOverlayHeight()}
          zIndex={20}
          border={true}
          borderStyle="rounded"
          borderColor={theme.spark}
          backgroundColor={theme.surface}
        >
          <AskOverlay
            screen={() => askScreen() as AskScreen}
            resources={props.resources}
            contentWidth={overlayContentWidth}
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
        backgroundColor={theme.background}
      >
        <box flexShrink={0} width="100%"><Status state={props.state} resources={props.resources} /></box>
        <box
          flexShrink={0}
          flexDirection="column"
          marginX={1}
          border={true}
          borderStyle="rounded"
          borderColor={state().busy ? theme.spark : theme.borderStrong}
          backgroundColor={theme.surfaceHigh}
        >
          <Show when={props.attachments().length > 0 || props.pasteBusy()}>
            <box flexDirection="row" width="100%" height={1} paddingLeft={1} paddingRight={1}>
              <text
                flexGrow={1}
                height={1}
                wrapMode="none"
                truncate={true}
                fg={theme.muted}
              >
                {attachmentSummary(props.attachments(), props.pasteBusy())}
              </text>
            </box>
          </Show>
          <box flexDirection="row" width="100%" paddingLeft={1}>
            <text width={2} height={1} wrapMode="none" fg={theme.accent} attributes={bold}>❯</text>
            <textarea
              ref={props.setComposer}
              flexGrow={1}
              height={props.composerHeight()}
              minHeight={COMPOSER_MIN_LINES}
              maxHeight={COMPOSER_MAX_LINES}
              wrapMode="word"
              placeholder="ask thread, / commands, @ files, Ctrl+V paste…"
              placeholderColor={theme.muted}
              textColor={theme.text}
              focusedTextColor={theme.text}
              backgroundColor={theme.surfaceHigh}
              focusedBackgroundColor={theme.surfaceHigh}
              cursorColor={theme.spark}
              selectionBg={theme.selection}
              selectionFg={theme.selectionText}
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
                if (props.pasteBusy()) {
                  props.controller.note("Wait for the clipboard image to finish processing.", "info");
                  return;
                }
                const images = [...props.attachments()];
                const command = isSlashCommandInput(input);
                if (images.length > 0 && !command && !props.controller.meta.acceptsImages) {
                  props.controller.note(
                    "Current model does not accept images. Use /model to pick a vision model.",
                    "error",
                  );
                  return;
                }
                editor.clear();
                props.setComposerText("");
                props.setComposerCursor(0);
                props.setForcePathCompletion(false);
                if (!command) props.setAttachments([]);
                void props.controller.submit(input, command ? [] : images);
              }}
            />
          </box>
        </box>
        <box flexShrink={0} width="100%">
          <Footer state={props.state} meta={props.meta} resources={props.resources} width={props.terminalWidth} />
        </box>
      </box>
    </box>
  );
}
