import assert from "node:assert/strict";
import test from "node:test";
import { createUiState, formatDurationMs, reduceUiEvent, statusLineParts } from "../src/ui/state.js";

test("status activity tracks in-flight tools instead of the last started name", () => {
  const state = createUiState("session", null, []);
  reduceUiEvent(state, { type: "turn_preparing", input: "go", sessionId: "session" });
  reduceUiEvent(state, { type: "tool_started", id: "a", name: "read", args: {}, phase: "queued" });
  reduceUiEvent(state, { type: "tool_started", id: "b", name: "grep", args: {}, phase: "queued" });
  assert.equal(state.activity, "read · grep");
  assert.equal(state.busy, true);

  reduceUiEvent(state, { type: "tool_started", id: "a", name: "read", args: {}, phase: "running" });
  reduceUiEvent(state, { type: "tool_started", id: "b", name: "grep", args: {}, phase: "running" });
  assert.equal(state.activity, "read · grep");

  reduceUiEvent(state, {
    type: "tool_finished",
    id: "a",
    name: "read",
    result: { content: "ok", isError: false },
    isError: false,
  });
  assert.equal(state.activity, "grep");

  reduceUiEvent(state, {
    type: "tool_finished",
    id: "b",
    name: "grep",
    result: { content: "ok", isError: false },
    isError: false,
  });
  assert.equal(state.activity, "thinking");
});

test("turn_finished does not drop the live turn before history is committed", () => {
  const state = createUiState("session", null, []);
  reduceUiEvent(state, { type: "turn_preparing", input: "go", sessionId: "session" });
  reduceUiEvent(state, { type: "turn_finished", outcome: "completed" });
  assert.equal(state.busy, true);
  assert.equal(state.activity, "preparing");
  assert.ok(state.liveTurn);
});

test("interrupted turns surface an info notice instead of an error", () => {
  const state = createUiState("session", null, []);
  reduceUiEvent(state, { type: "turn_finished", outcome: "interrupted" });
  assert.deepEqual(state.notice, { level: "info", text: "Interrupted" });
});

test("formatDurationMs uses fractional seconds below a minute", () => {
  assert.equal(formatDurationMs(0), "0.0s");
  assert.equal(formatDurationMs(1500), "1.5s");
  assert.equal(formatDurationMs(59_900), "59.9s");
  assert.equal(formatDurationMs(61_000), "1m 01s");
  assert.equal(formatDurationMs(3_600_000), "1h 00m");
});

test("status line tracks turn elapsed while running and after it finishes", () => {
  const state = createUiState("session", null, []);
  reduceUiEvent(state, { type: "turn_preparing", input: "go", sessionId: "session" });
  assert.equal(state.turnStartedAt !== undefined, true);
  assert.equal(state.turnFinishedAt, undefined);
  const running = statusLineParts(state, state.turnStartedAt! + 2300);
  assert.equal(running.main, "preparing");
  assert.equal(running.elapsed, "2.3s");

  reduceUiEvent(state, { type: "turn_finished", outcome: "completed" });
  assert.equal(state.turnFinishedAt !== undefined, true);
  state.busy = false;
  state.activity = undefined;
  const done = statusLineParts(state, state.turnStartedAt! + 99_000);
  assert.equal(done.main, `worked ${formatDurationMs(state.turnFinishedAt! - state.turnStartedAt!)}`);
  assert.equal(done.elapsed, undefined);

  reduceUiEvent(state, { type: "command_started", name: "model" });
  assert.equal(state.turnStartedAt, undefined);
  assert.equal(statusLineParts(state, Date.now()).elapsed, undefined);
});
