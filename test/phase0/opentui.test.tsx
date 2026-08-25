import assert from "node:assert/strict";
import { test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createUiState, type TranscriptItem, type UiState } from "../../src/ui/state.js";
import type { TerminalKey, TerminalMeta, ThreadTuiViewModel } from "../../src/ui/terminal/controller.js";
import type { ThreadViewResources } from "../../src/ui/terminal/resources.js";
import { createThreadSyntaxStyle, terminalTheme } from "../../src/ui/terminal/theme.js";
import { createWheelScrollAcceleration, WHEEL_SCROLL_BASE } from "../../src/ui/terminal/scroll.js";
import { groupTranscriptTurns, normalizeMarkdownForTerminal, reconcileTurnGroups } from "../../src/ui/terminal/transcript.js";
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

test("unchanged turns keep their group identity when a new message arrives", () => {
  const first: TranscriptItem[] = [
    { id: "user-1", kind: "user", content: "first" },
    { id: "reply-1", kind: "assistant", content: "done" },
  ];
  const groups = groupTranscriptTurns(first);
  const settled = reconcileTurnGroups(groups, []);

  // A later sync rebuilds every item from the session log.
  const rebuilt = groupTranscriptTurns([
    { id: "user-1", kind: "user", content: "first" },
    { id: "reply-1", kind: "assistant", content: "done" },
    { id: "user-2", kind: "user", content: "second" },
  ]);
  const reconciled = reconcileTurnGroups(rebuilt, settled);
  assert.equal(reconciled[0], settled[0], "the untouched turn must keep its object identity");
  assert.equal(reconciled.length, 2);
  assert.equal(reconciled[1]!.id, "user-2");

  // A turn whose content actually grew must be replaced.
  const grown = reconcileTurnGroups(
    groupTranscriptTurns([
      { id: "user-1", kind: "user", content: "first" },
      { id: "reply-1", kind: "assistant", content: "done, with more" },
    ]),
    settled,
  );
  assert.notEqual(grown[0], settled[0], "changed turns must produce a fresh group");
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

    /* The reported jitter: sending a new message re-projected the whole
     * transcript, and <For> rebuilt every committed reply. The settled reply
     * must keep its renderable while a later turn streams above it. */
    const settled = setup.renderer.root.findDescendantById("history-markdown-assistant-1");
    assert.ok(settled, "committed replies need a stable id to be reconciled");
    state.transcript = [
      { id: "assistant-1", kind: "assistant", content: "A **completed** response." },
      { id: "user-2", kind: "user", content: "a second question" },
    ];
    state.liveTurn = {
      ...state.liveTurn,
      blocks: [
        state.liveTurn.blocks[0]!,
        { ...state.liveTurn.blocks[1]!, content: "First streamed reply update. More." },
      ],
    };
    viewModel.notify();
    await setup.flush();
    assert.equal(
      setup.renderer.root.findDescendantById("history-markdown-assistant-1"),
      settled,
      "a new user message must not rebuild already-rendered replies",
    );
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
    assert.match(frame, /◇ thinking/, "committed thinking keeps its heading in the preview");
    assert.match(frame, /✓ bash {2}bun test/, "committed tools render as compact rows");
    assert.match(frame, /context main/, "footer labels the displayed version as context");
    assert.doesNotMatch(frame, /dirty/, "footer omits workspace dirty status");
    assert.match(frame, /███░░░ ctx 42%/, "footer carries the context meter");
    assert.match(frame, /❯ ask thread, \/ for commands, @ to add files/, "composer placeholder carries the merged hints");
    assert.doesNotMatch(frame, /⏎ send/, "send/newline hints stay out of the composer");
    assert.match(frame, /⇧⇥ switch thinking level/, "footer explains the thinking-level shortcut");
    assert.match(frame, /esc interrupt/, "busy status keeps the escape hint");
  } finally {
    setup.renderer.destroy();
    viewResources.syntaxStyle.destroy();
  }
});

test("completed thinking clips to five rows and expands on mouse click", async () => {
  const viewResources = resources();
  const state = createUiState("main", "checkpoint-123456789", [
    {
      id: "think-long",
      kind: "thinking",
      content: "first-preview ".repeat(40) + "tail-marker",
    },
  ]);
  const meta: TerminalMeta = {
    rootPath: process.cwd(),
    modelLabel: "faux/reasoner",
    modelName: "reasoner",
    thinkingLevel: "high",
    supportsThinking: true,
    contextPercent: 0,
    uncommitted: false,
  };
  const viewModel = fakeViewModel(state, meta);
  const setup = await testRender(
    () => <ThreadRoot controller={viewModel.controller} resources={viewResources} />,
    { width: 80, height: 24, screenMode: "alternate-screen", kittyKeyboard: true },
  );
  try {
    await setup.flush();
    let frame = setup.captureCharFrame();
    assert.match(frame, /click to expand/, "long thinking exposes the expand affordance");
    assert.match(frame, /first-preview/, "the collapsed preview keeps its beginning visible");
    assert.doesNotMatch(frame, /tail-marker/, "the collapsed preview clips the long tail");

    await setup.mockMouse.click(4, 4);
    await setup.flush();
    frame = setup.captureCharFrame();
    assert.match(frame, /click to collapse/, "clicking the block expands it");
    assert.match(frame, /tail-marker/, "the expanded block renders the full content");

    await setup.mockMouse.click(4, 4);
    await setup.flush();
    frame = setup.captureCharFrame();
    assert.match(frame, /click to expand/, "clicking the block again collapses it");
    assert.doesNotMatch(frame, /tail-marker/, "the collapsed block hides the long tail again");

    state.transcript = [{ id: "think-short", kind: "thinking", content: "short thought" }];
    viewModel.notify();
    await setup.flush();
    frame = setup.captureCharFrame();
    assert.doesNotMatch(frame, /click to (?:expand|collapse)/, "short thinking has no collapse affordance");
    assert.match(frame, /short thought/);
  } finally {
    setup.renderer.destroy();
    viewResources.syntaxStyle.destroy();
  }
});

test("the /model overlay moves its highlight view-side, without a controller round-trip", async () => {
  const viewResources = resources();
  const state = createUiState("main", "checkpoint-123456789", [
    { id: "user-1", kind: "user", content: "hello" },
  ]);
  state.screen = {
    type: "model_picker",
    models: [
      { providerId: "faux", modelId: "alpha", name: "Alpha", contextWindow: 100_000, maxOutputTokens: 8_000, reasoning: false },
      { providerId: "faux", modelId: "beta", name: "Beta", contextWindow: 200_000, maxOutputTokens: 8_000, reasoning: true },
    ],
    currentProviderId: "faux",
    currentModelId: "alpha",
    scope: "configured",
    selected: 0,
    busy: false,
    error: undefined,
  };
  const meta: TerminalMeta = {
    rootPath: process.cwd(),
    modelLabel: "faux/alpha",
    modelName: "alpha",
    thinkingLevel: "off",
    supportsThinking: false,
    contextPercent: 4,
    uncommitted: false,
  };
  const viewModel = fakeViewModel(state, meta);
  viewModel.controller.handleScreenKey = (key) => {
    if (key.name === "up" || key.name === "down") {
      throw new Error("overlay arrow keys must stay view-side; a controller round-trip per keystroke is what flickered");
    }
    return false;
  };
  const setup = await testRender(
    () => <ThreadRoot controller={viewModel.controller} resources={viewResources} />,
    { width: 80, height: 24, screenMode: "alternate-screen", kittyKeyboard: true },
  );
  try {
    await setup.flush();
    assert.match(setup.captureCharFrame(), /▸ faux\/alpha/, "selection starts on the current model");
    setup.mockInput.pressArrow("down");
    await setup.flush();
    const frame = setup.captureCharFrame();
    assert.match(frame, /▸ faux\/beta/, "down arrow moves the highlight");
    assert.doesNotMatch(frame, /▸ faux\/alpha/, "the previous row loses its marker");
    setup.mockInput.pressArrow("up");
    await setup.flush();
    assert.match(setup.captureCharFrame(), /▸ faux\/alpha/, "up arrow moves back");
  } finally {
    setup.renderer.destroy();
    viewResources.syntaxStyle.destroy();
  }
});

test("the /rewind overlay lists user messages as rewind targets and navigates view-side", async () => {
  const viewResources = resources();
  const state = createUiState("main", "checkpoint-123456789", [
    { id: "user-2", kind: "user", content: "second question" },
  ]);
  state.screen = {
    type: "rewind",
    items: [
      { turnId: "turn_zzzzzzzzzzzzzz2", userEntryId: "entry-2", baseCheckpointId: "checkpoint-b", label: "second question", outcome: "completed", startedAt: 1_700_000_060_000 },
      { turnId: "turn_aaaaaaaaaaaaaa1", userEntryId: "entry-1", baseCheckpointId: "checkpoint-a", label: "first question", outcome: "completed", startedAt: 1_700_000_000_000 },
    ],
    selected: 0,
    confirm: false,
    busy: false,
    error: undefined,
  };
  const meta: TerminalMeta = {
    rootPath: process.cwd(),
    modelLabel: "faux/alpha",
    modelName: "alpha",
    thinkingLevel: "off",
    supportsThinking: false,
    contextPercent: 4,
    uncommitted: false,
  };
  const viewModel = fakeViewModel(state, meta);
  viewModel.controller.handleScreenKey = (key) => {
    if (key.name === "up" || key.name === "down") throw new Error("overlay arrow keys must stay view-side");
    return false;
  };
  const setup = await testRender(
    () => <ThreadRoot controller={viewModel.controller} resources={viewResources} />,
    { width: 80, height: 24, screenMode: "alternate-screen", kittyKeyboard: true },
  );
  try {
    await setup.flush();
    let frame = setup.captureCharFrame();
    assert.match(frame, /rewind to before a user message/, "header names the user-message entry points");
    assert.match(frame, /▸ second question/, "the newest user message is selected first");
    assert.match(frame, /first question/, "the older user message is listed below");
    setup.mockInput.pressArrow("down");
    await setup.flush();
    frame = setup.captureCharFrame();
    assert.match(frame, /▸ first question/, "down arrow moves the highlight to the older message");
    assert.doesNotMatch(frame, /▸ second question/, "the previous row loses its marker");
  } finally {
    setup.renderer.destroy();
    viewResources.syntaxStyle.destroy();
  }
});

test("the /session overlay marks the active session and navigates view-side", async () => {
  const viewResources = resources();
  const state = createUiState("main", "checkpoint-123456789", []);
  state.screen = {
    type: "session_picker",
    sessions: [
      { id: "session_current111111", createdAt: 1_700_000_000_000, lastActivatedAt: 1_700_000_120_000, current: true },
      { id: "session_previous2222", createdAt: 1_699_000_000_000, lastActivatedAt: 1_700_000_060_000, current: false },
    ],
    selected: 0,
    busy: false,
    error: undefined,
  };
  const meta: TerminalMeta = {
    rootPath: process.cwd(),
    modelLabel: "no model",
    modelName: "no model",
    thinkingLevel: "off",
    supportsThinking: false,
    contextPercent: 0,
    uncommitted: false,
  };
  const viewModel = fakeViewModel(state, meta);
  viewModel.controller.handleScreenKey = (key) => {
    if (key.name === "up" || key.name === "down") throw new Error("overlay arrow keys must stay view-side");
    return false;
  };
  const setup = await testRender(
    () => <ThreadRoot controller={viewModel.controller} resources={viewResources} />,
    { width: 80, height: 24, screenMode: "alternate-screen", kittyKeyboard: true },
  );
  try {
    await setup.flush();
    let frame = setup.captureCharFrame();
    assert.match(frame, /project sessions · most recently activated first/);
    assert.match(frame, /▸ session_current111111/);
    assert.match(frame, /session_previous2222/);
    setup.mockInput.pressArrow("down");
    await setup.flush();
    frame = setup.captureCharFrame();
    assert.match(frame, /▸ session_previous2222/);
    assert.doesNotMatch(frame, /▸ session_current111111/);
  } finally {
    setup.renderer.destroy();
    viewResources.syntaxStyle.destroy();
  }
});
