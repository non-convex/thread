import assert from "node:assert/strict";
import { test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createUiState, type UiState } from "../../src/ui/state.js";
import type { TerminalKey, TerminalMeta, ThreadTuiViewModel } from "../../src/ui/terminal/controller.js";
import type { ThreadViewResources } from "../../src/ui/terminal/resources.js";
import { createThreadSyntaxStyle, terminalTheme } from "../../src/ui/terminal/theme.js";
import { normalizeMarkdownForTerminal } from "../../src/ui/terminal/transcript.js";
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

test("source-range Markdown fences are normalized for OpenTUI", () => {
  const content = [
    "```47:53:src/session/service.ts",
    "function compactionMessage() {}",
    "```",
  ].join("\n");
  assert.match(normalizeMarkdownForTerminal(content), /^```typescript$/m);
  assert.doesNotMatch(normalizeMarkdownForTerminal(content), /47:53:src/);
});

test("the full-screen session updates in place while a streamed reply grows", async () => {
  const viewResources = resources();
  const state = createUiState("main", "checkpoint-123456789", [
    { id: "assistant-1", kind: "assistant", content: "A **completed** response." },
  ]);
  const meta: TerminalMeta = {
    rootPath: process.cwd(),
    modelLabel: "faux/reasoner",
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
