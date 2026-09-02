import assert from "node:assert/strict";
import test from "node:test";
import { createUiState, reduceUiEvent } from "../src/ui/state.js";

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
