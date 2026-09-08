import assert from "node:assert/strict";
import test from "node:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { ThinkingView, ToolOutputView } from "../src/ui/terminal/transcript-content.js";
import { groupTranscriptTurns, reconcileTurnGroups } from "../src/ui/terminal/transcript-projection.js";
import { createThreadSyntaxStyle, terminalTheme } from "../src/ui/terminal/theme.js";
import type { LiveTool, TranscriptItem } from "../src/ui/state.js";

test("tool output keeps its preview, expands on click and displays failed results", async () => {
  const theme = terminalTheme("dark");
  const syntaxStyle = createThreadSyntaxStyle(theme);
  const [status, setStatus] = createSignal<LiveTool["status"]>("completed");
  const [content, setContent] = createSignal(Array.from({ length: 8 }, (_, index) => `result ${index + 1}`).join("\n"));
  const view = await testRender(() => (
    <ToolOutputView name="read" args="notes.txt" status={status()} content={content()} resources={{ theme, syntaxStyle }} />
  ), { width: 80, height: 14 });
  try {
    await view.renderOnce();
    assert.match(view.captureCharFrame(), /result 5/);
    assert.doesNotMatch(view.captureCharFrame(), /result 6/);
    await view.mockMouse.click(4, 0);
    await view.renderOnce();
    assert.match(view.captureCharFrame(), /result 8/);
    setStatus("failed");
    setContent("Permission denied by the host");
    await view.renderOnce();
    assert.match(view.captureCharFrame(), /Permission denied by the host/);
    assert.match(view.captureCharFrame(), /✗/);
  } finally {
    view.renderer.destroy();
    syntaxStyle.destroy();
  }
});

test("thinking content stays reactive after using ordinary component props", async () => {
  const theme = terminalTheme("dark");
  const syntaxStyle = createThreadSyntaxStyle(theme);
  const [content, setContent] = createSignal("First reasoning block");
  const view = await testRender(() => <ThinkingView content={content()} resources={{ theme, syntaxStyle }} />, { width: 80, height: 10 });
  try {
    await view.renderOnce();
    assert.match(view.captureCharFrame(), /First reasoning block/);
    setContent("Updated reasoning block");
    await view.renderOnce();
    assert.match(view.captureCharFrame(), /Updated reasoning block/);
    assert.doesNotMatch(view.captureCharFrame(), /First reasoning block/);
  } finally {
    view.renderer.destroy();
    syntaxStyle.destroy();
  }
});

test("transcript reconciliation retains unchanged rows but refreshes elapsed time", () => {
  const items: TranscriptItem[] = [
    { id: "user", kind: "user", content: "read" },
    { id: "tool", kind: "tool", content: "ok", elapsed: "0.1s" },
  ];
  const previous = groupTranscriptTurns(structuredClone(items));
  assert.equal(reconcileTurnGroups(groupTranscriptTurns(structuredClone(items)), previous)[0], previous[0]);
  items[1]!.elapsed = "1.0s";
  const updated = reconcileTurnGroups(groupTranscriptTurns(items), previous);
  assert.notEqual(updated[0], previous[0]);
  assert.equal(updated[0]?.items[0]?.elapsed, "1.0s");
});
