import assert from "node:assert/strict";
import { test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createUiState, type UiState } from "../../src/ui/state.js";
import type { TerminalKey, TerminalMeta, ThreadTuiViewModel } from "../../src/ui/terminal/controller.js";
import type { ThreadViewResources } from "../../src/ui/terminal/resources.js";
import { createThreadSyntaxStyle, terminalTheme } from "../../src/ui/terminal/theme.js";
import { createWheelScrollAcceleration, WHEEL_SCROLL_BASE } from "../../src/ui/terminal/scroll.js";
import { groupTranscriptTurns, normalizeMarkdownForTerminal } from "../../src/ui/terminal/transcript.js";
import { contextMeter } from "../../src/ui/terminal/session-screen.js";
import { ThreadRoot } from "../../src/ui/terminal/view.js";

function resources(): ThreadViewResources {
  const theme = terminalTheme("dark");
  return { theme, syntaxStyle: createThreadSyntaxStyle(theme) };
}

function fakeViewModel(state: UiState, meta: TerminalMeta): {
  controller: ThreadTuiViewModel;
  notify: () => void;
} {
  const listeners = new Set<() => void>();
  return {
    controller: {
      state,
      meta,
      slashSuggestions: [{ name: "model", description: "Switch model" }],
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      interrupt: () => false,
      idleCtrlC: () => false,
      cancelIdleExitGesture: () => undefined,
      cycleThinkingLevel: () => undefined,
      closeView: () => undefined,
      handleScreenKey: (_key: TerminalKey) => false,
      submit: async () => undefined,
      requestStop: () => undefined,
    },
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
}

test("wheel scroll acceleration starts at three rows and ramps on a fast streak", () => {
  const accel = createWheelScrollAcceleration();
  assert.equal(accel.tick(1_000), WHEEL_SCROLL_BASE);
  assert.ok(accel.tick(1_020) > WHEEL_SCROLL_BASE);
  accel.reset();
  assert.equal(accel.tick(2_000), WHEEL_SCROLL_BASE);
});

test("source-range Markdown fences are normalized for OpenTUI", () => {
  const content = [
    "```47:53:src/session/service.ts",
    "function compactionMessage() {}",
    "```",
  ].join("\n");
  assert.match(normalizeMarkdownForTerminal(content), /^```typescript$/m);
  assert.doesNotMatch(normalizeMarkdownForTerminal(content), /47:53:src/);
});

test("transcript items group into turns anchored by user messages", () => {
  const groups = groupTranscriptTurns([
    { id: "import-1", kind: "context_merge", content: "imported" },
    { id: "user-1", kind: "user", content: "first" },
    { id: "think-1", kind: "thinking", content: "…" },
    { id: "tool-1", kind: "tool", content: "ok", name: "read", args: "README.md" },
    { id: "reply-1", kind: "assistant", content: "done" },
    { id: "user-2", kind: "user", content: "second" },
    { id: "reply-2", kind: "assistant", content: "again" },
  ]);
  assert.deepEqual(
    groups.map((group) => ({ user: group.user?.id, items: group.items.map((item) => item.id) })),
    [
      { user: undefined, items: ["import-1"] },
      { user: "user-1", items: ["think-1", "tool-1", "reply-1"] },
      { user: "user-2", items: ["reply-2"] },
    ],
  );
});

test("the context meter fills in six cells", () => {
  assert.equal(contextMeter(0), "░░░░░░");
  assert.equal(contextMeter(42), "███░░░");
  assert.equal(contextMeter(100), "██████");
  assert.equal(contextMeter(140), "██████", "clamps overflow");
});

test("the full-screen session updates in place while a streamed reply grows", async () => {
  const viewResources = resources();
  const state = createUiState("main", "checkpoint-123456789", [
    { id: "assistant-1", kind: "assistant", content: "A **completed** response." },
  ]);
  const meta: TerminalMeta = {
    rootPath: process.cwd(),
    modelLabel: "faux/reasoner",
    modelName: "reasoner",
    thinkingLevel: "high",
    supportsThinking: true,
    contextPercent: 4,
    uncommitted: true,
  };
  const viewModel = fakeViewModel(state, meta);
  const setup = await testRender(
    () => <ThreadRoot controller={viewModel.controller} resources={viewResources} />,
    { width: 80, height: 24, screenMode: "alternate-screen", kittyKeyboard: true },
  );
  try {
    await setup.flush();
    assert.match(setup.captureCharFrame(), /A completed response\./);

    state.busy = true;
    state.activity = "responding · step 1";
    state.liveTurn = {
      id: "turn-1",
      input: "inspect the project",
      branch: "main",
      blocks: [
        { id: "thinking:1", kind: "thinking", content: "First think.", streaming: false },
        { id: "assistant:2", kind: "assistant", content: "First", streaming: true },
      ],
      startedAt: Date.now(),
    };
    viewModel.notify();
    await setup.flush();
    const first = setup.renderer.root.findDescendantById("live-markdown-assistant:2");
    assert.ok(first);
    assert.match(setup.captureCharFrame(), /responding · step 1/);

    state.liveTurn = {
      ...state.liveTurn,
      blocks: [
        state.liveTurn.blocks[0]!,
        { ...state.liveTurn.blocks[1]!, content: "First streamed reply update." },
      ],
    };
    viewModel.notify();
    await setup.flush();
    const updated = setup.renderer.root.findDescendantById("live-markdown-assistant:2");
    assert.equal(updated, first, "token deltas must update the existing Markdown renderable in place");
    assert.match(setup.captureCharFrame(), /First streamed reply update\./);
  } finally {
    setup.renderer.destroy();
    viewResources.syntaxStyle.destroy();
  }
});

test("the composer submits multiline input and selected slash commands", async () => {
  const viewResources = resources();
  const state = createUiState("main", "checkpoint-123456789", []);
  const meta: TerminalMeta = {
    rootPath: process.cwd(),
    modelLabel: "faux/model",
    modelName: "model",
    thinkingLevel: "off",
    supportsThinking: false,
    contextPercent: 0,
    uncommitted: false,
  };
  const viewModel = fakeViewModel(state, meta);
  const submitted: string[] = [];
  viewModel.controller.submit = async (input) => { submitted.push(input); };
  const setup = await testRender(
    () => <ThreadRoot controller={viewModel.controller} resources={viewResources} />,
    { width: 80, height: 24, screenMode: "alternate-screen", kittyKeyboard: true },
  );
  try {
    await setup.flush();
    await setup.mockInput.typeText("first line");
    setup.mockInput.pressEnter({ shift: true });
    await setup.mockInput.typeText("second line");
    setup.mockInput.pressEnter();
    await setup.flush();
    assert.equal(submitted[0], "first line\nsecond line");

    await setup.mockInput.typeText("/mo");
    setup.mockInput.pressEnter();
    await setup.flush();
    assert.equal(submitted[1], "/model");
  } finally {
    setup.renderer.destroy();
    viewResources.syntaxStyle.destroy();
  }
});

test("the session screen renders the redesign language: rail, collapsed thinking, tool elapsed, footer meter", async () => {
  const viewResources = resources();
  const now = Date.now();
  const state = createUiState("main", "checkpoint-123456789", [
    { id: "user-1", kind: "user", content: "run the tests" },
    { id: "think-1", kind: "thinking", content: "old thoughts stay folded" },
    { id: "tool-1", kind: "tool", name: "bash", args: "bun test", content: "12 pass", isError: false },
  ]);
  const meta: TerminalMeta = {
    rootPath: process.cwd(),
    modelLabel: "faux/reasoner",
    modelName: "reasoner",
    thinkingLevel: "high",
    supportsThinking: true,
    contextPercent: 42,
    uncommitted: true,
  };
  state.busy = true;
  state.activity = "edit";
  state.liveTurn = {
    id: "turn-1",
    input: "run the tests",
    branch: "main",
    startedAt: now - 5_000,
    blocks: [
      { id: "thinking:1", kind: "thinking", content: "folded once done", streaming: false, startedAt: now - 5_000, finishedAt: now - 2_600 },
      { id: "tool:1", kind: "tool", content: "", tool: { id: "t1", name: "read", args: { path: "src/app.ts" }, status: "completed", startedAt: now - 2_500, finishedAt: now - 400 } },
    ],
  };
  const viewModel = fakeViewModel(state, meta);
  const setup = await testRender(
    () => <ThreadRoot controller={viewModel.controller} resources={viewResources} />,
    { width: 80, height: 24, screenMode: "alternate-screen", kittyKeyboard: true },
  );
  try {
    await setup.flush();
    const frame = setup.captureCharFrame();
    assert.match(frame, /● thread · reasoner/, "turn rail names the bare model");
    assert.match(frame, /◇ thought 2\.4s/, "finished thinking collapses to one timed line");
    assert.match(frame, /✓ read {2}src\/app\.ts +2\.1s/, "tool row ends with its elapsed time");
    assert.match(frame, /◇ thinking/, "committed thinking folds into a single line");
    assert.match(frame, /✓ bash {2}bun test/, "committed tools render as compact rows");
    assert.match(frame, /███░░░ ctx 42%/, "footer carries the context meter");
    assert.match(frame, /⏎ send · ⇧⏎ newline · \/ commands · @ paths/, "composer keeps the hint row");
    assert.match(frame, /esc interrupt/, "busy status keeps the escape hint");
  } finally {
    setup.renderer.destroy();
    viewResources.syntaxStyle.destroy();
  }
});

