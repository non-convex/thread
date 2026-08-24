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
