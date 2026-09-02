import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTaskSummary } from "../src/agent-task/model.js";
import { createUiState, formatDurationMs, reduceUiEvent, statusLineParts } from "../src/ui/state.js";
import { projectTranscript } from "../src/ui/terminal/transcript-projection.js";

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
    isError: false,
  });
  assert.equal(state.activity, "grep");

  reduceUiEvent(state, {
    type: "tool_finished",
    id: "b",
    name: "grep",
    isError: false,
  });
  assert.equal(state.activity, "thinking");
});

test("worker tool queue and start events update one live row", () => {
  const state = createUiState("session", null, []);
  const summary: AgentTaskSummary = {
    taskId: "task",
    parentTurnId: "turn",
    toolCallId: "delegate",
    title: "worker",
    status: "running",
    profileId: "implementation-worker",
    providerId: "test",
    modelId: "test",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    elapsedMs: 0,
    contextTokens: 0,
    changedFiles: 0,
    scopeViolations: [],
  };
  reduceUiEvent(state, { type: "turn_preparing", input: "go", sessionId: "session" });
  reduceUiEvent(state, { type: "agent_task_created", summary });
  reduceUiEvent(state, {
    type: "agent_task_trace",
    taskId: "task",
    event: { type: "tool_started", id: "read", name: "read", args: {}, phase: "queued" },
  });
  reduceUiEvent(state, {
    type: "agent_task_trace",
    taskId: "task",
    event: { type: "tool_started", id: "read", name: "read", args: {}, phase: "running" },
  });
  reduceUiEvent(state, {
    type: "agent_task_trace",
    taskId: "task",
    event: { type: "tool_finished", id: "read", name: "read", isError: true, error: "failed" },
  });

  const card = state.liveTurn?.blocks.find((block) => block.agentTask)?.agentTask;
  assert.equal(card?.trace.length, 1);
  assert.equal(card?.trace[0]?.tool?.status, "failed");
  assert.equal(card?.trace[0]?.tool?.error, "failed");
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

test("compaction rows keep the full summary for expansion", () => {
  const items = projectTranscript([{
    id: "entry-compact",
    sessionId: "session",
    turnId: "turn",
    ordinal: 0,
    timestamp: 1,
    type: "compaction",
    summary: "## Long-term memory\n\n- kept",
    retainedTurns: [],
    tokensBefore: 100,
    reason: "threshold",
  }]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "compaction");
  assert.equal(items[0]!.content, "context compacted · threshold");
  assert.equal(items[0]!.detail, "## Long-term memory\n\n- kept");

  const state = createUiState("session", null, []);
  reduceUiEvent(state, { type: "turn_preparing", input: "go", sessionId: "session" });
  reduceUiEvent(state, {
    type: "compaction_finished",
    reason: "manual",
    ok: true,
    entryId: "entry-live",
    summarizedSteps: 7,
    retainedSteps: 5,
    tokensSaved: 42_000,
  });
  const block = state.liveTurn?.blocks.find((item) => item.kind === "compaction");
  assert.equal(block?.content, "context compacted · manual");
  assert.equal(block?.detail, "7 step(s) summarized · 5 retained · ~42000 tokens freed");
});
