import assert from "node:assert/strict";
import test from "node:test";
import { UiEventBatcher } from "../../src/ui/events.js";
import { createUiState, reduceUiEvent } from "../../src/ui/state.js";

test("live turns keep thinking, tools and replies in arrival order", () => {
  const state = createUiState("main", "checkpoint", []);
  reduceUiEvent(state, { type: "turn_started", turnId: "turn-1", input: "inspect", branch: "main" });
  reduceUiEvent(state, { type: "assistant_started", step: 1 });
  reduceUiEvent(state, { type: "assistant_thinking_delta", step: 1, delta: "look at README" });
  reduceUiEvent(state, { type: "tool_started", id: "call-1", name: "read", args: { path: "README.md" } });
  reduceUiEvent(state, {
    type: "tool_finished",
    id: "call-1",
    name: "read",
    result: { content: "# thread", isError: false },
    isError: false,
  });
  reduceUiEvent(state, { type: "assistant_text_delta", step: 2, delta: "The project is ready." });

  const started = state.liveTurn;
  reduceUiEvent(state, { type: "assistant_text_delta", step: 2, delta: " More." });
  assert.notEqual(state.liveTurn, started);
  assert.deepEqual(state.liveTurn?.blocks.map((block) => block.kind), ["thinking", "tool", "assistant"]);
  assert.equal(state.liveTurn?.blocks[0]?.content, "look at README");
  assert.equal(state.liveTurn?.blocks[1]?.tool?.status, "completed");
  assert.equal(state.liveTurn?.blocks[2]?.content, "The project is ready. More.");
  assert.equal(state.liveTurn?.blocks[2]?.streaming, true);
});

test("model retry events surface progress and discard the partial reply", () => {
  const state = createUiState("main", "checkpoint", []);
  reduceUiEvent(state, { type: "turn_started", turnId: "turn-1", input: "inspect", branch: "main" });
  reduceUiEvent(state, { type: "assistant_started", step: 1 });
  reduceUiEvent(state, { type: "assistant_text_delta", step: 1, delta: "partial reply" });
  assert.ok(state.liveTurn?.blocks.some((block) => block.kind === "assistant" && block.streaming));

  reduceUiEvent(state, {
    type: "model_retry_scheduled",
    step: 1,
    attempt: 1,
    maxAttempts: 6,
    delayMs: 1_000,
    errorMessage: "overloaded",
  });
  assert.equal(state.activity, "retrying model · attempt 1/6 in 1.0s");

  reduceUiEvent(state, { type: "model_retry_started", step: 1, attempt: 1, maxAttempts: 6 });
  assert.equal(state.activity, "retrying model · attempt 1/6");
  assert.equal(state.liveTurn?.blocks.some((block) => block.kind === "assistant" && block.streaming), false);
});

test("the UI event batcher keeps thinking and reply streams separate", () => {
  const events: string[] = [];
  const batcher = new UiEventBatcher((event) => {
    if (event.type === "assistant_thinking_delta" || event.type === "assistant_text_delta") {
      events.push(`${event.type}:${event.delta}`);
    }
  }, 1_000);
  try {
    batcher.push({ type: "assistant_thinking_delta", step: 1, delta: "think " });
    batcher.push({ type: "assistant_thinking_delta", step: 1, delta: "more" });
    batcher.push({ type: "assistant_text_delta", step: 1, delta: "answer" });
    batcher.flush();
    assert.deepEqual(events, ["assistant_thinking_delta:think more", "assistant_text_delta:answer"]);
  } finally {
    batcher.dispose();
  }
});

test("live blocks and tools carry timing for collapsed thinking lines and elapsed tool rows", () => {
  const state = createUiState("main", "checkpoint", []);
  reduceUiEvent(state, { type: "turn_started", turnId: "turn-1", input: "inspect", branch: "main" });
  reduceUiEvent(state, { type: "assistant_thinking_delta", step: 1, delta: "look at README" });
  reduceUiEvent(state, { type: "tool_started", id: "call-1", name: "read", args: { path: "README.md" } });

  const thinking = state.liveTurn?.blocks[0];
  assert.equal(thinking?.streaming, false, "starting a tool closes the thinking stream");
  assert.equal(typeof thinking?.startedAt, "number");
  assert.equal(typeof thinking?.finishedAt, "number");
  assert.ok(thinking!.finishedAt! >= thinking!.startedAt!);

  const tool = state.liveTurn?.blocks[1]?.tool;
  assert.equal(typeof tool?.startedAt, "number");
  assert.equal(tool?.finishedAt, undefined, "running tools have no finish time yet");

  reduceUiEvent(state, {
    type: "tool_finished",
    id: "call-1",
    name: "read",
    result: { content: "ok", isError: false },
    isError: false,
  });
  const finished = state.liveTurn?.blocks[1]?.tool;
  assert.equal(finished?.status, "completed");
  assert.ok(finished!.finishedAt! >= finished!.startedAt!);
});

