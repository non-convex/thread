import assert from "node:assert/strict";
import test from "node:test";
import { UiEventBatcher, type UiEvent } from "../src/ui/events.js";

test("UI events share one frame batch while adjacent deltas retain source order", () => {
  const batches: UiEvent[][] = [];
  const batcher = new UiEventBatcher((events) => batches.push([...events]), 60_000);

  batcher.push({ type: "assistant_text_delta", step: 1, delta: "a" });
  batcher.push({ type: "assistant_text_delta", step: 1, delta: "b" });
  batcher.push({ type: "tool_started", id: "parent", name: "read", args: {}, phase: "running" });
  batcher.push({
    type: "agent_task_trace",
    taskId: "task-a",
    event: { type: "assistant_thinking_delta", step: 2, delta: "x" },
  });
  batcher.push({
    type: "agent_task_trace",
    taskId: "task-a",
    event: { type: "assistant_thinking_delta", step: 2, delta: "y" },
  });
  batcher.push({
    type: "agent_task_trace",
    taskId: "task-b",
    event: { type: "assistant_text_delta", step: 1, delta: "z" },
  });
  batcher.flush();

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0], [
    { type: "assistant_text_delta", step: 1, delta: "ab" },
    { type: "tool_started", id: "parent", name: "read", args: {}, phase: "running" },
    {
      type: "agent_task_trace",
      taskId: "task-a",
      event: { type: "assistant_thinking_delta", step: 2, delta: "xy" },
    },
    {
      type: "agent_task_trace",
      taskId: "task-b",
      event: { type: "assistant_text_delta", step: 1, delta: "z" },
    },
  ]);

  batcher.dispose();
});
