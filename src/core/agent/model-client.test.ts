import { expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage, type Context, type Model, type Models, type ToolCall,
} from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { abortedToolResult } from "../session-tree/conversation-seal.js";
import { PiModelClient } from "./model-client.js";

const model: Model<"openai-responses"> = {
  id: "test-model", name: "Test model", api: "openai-responses", provider: "openai",
  baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000, maxTokens: 1_000,
};

function assistant(stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    stopReason, content, timestamp: 1,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test.each(["aborted", "error"] as const)("continuation after an %s response has no orphaned tool output", async (stopReason) => {
  const read: ToolCall = { type: "toolCall", id: "call_read|fc_read", name: "read", arguments: { path: "doc.md" } };
  const write: ToolCall = { type: "toolCall", id: "call_write|fc_write", name: "write", arguments: { path: "doc.md", content: "draft" } };
  const cancelled: ToolCall = { ...write, id: "call_cancelled|fc_cancelled" };
  const continued = assistant("stop", [{ type: "text", text: "Resumed" }]);
  const context: Context = {
    messages: [
      { role: "user", content: "Edit the document", timestamp: 0 },
      assistant("toolUse", [read]),
      { role: "toolResult", toolCallId: read.id, toolName: read.name, content: [{ type: "text", text: "Original" }], isError: false, timestamp: 1 },
      assistant(stopReason, [
        { type: "thinking", thinking: "Partial reasoning", thinkingSignature: "incomplete signature" },
        write,
      ]),
      abortedToolResult(write, "Assistant response cannot release tool execution"),
      { role: "user", content: "Try again", timestamp: 2 },
      // A complete model response followed by an interrupted tool must retain both sides.
      assistant("toolUse", [cancelled]),
      abortedToolResult(cancelled, "Interrupted by user"),
      { role: "user", content: "Continue", timestamp: 3 },
    ],
  };
  const original = structuredClone(context);
  let dispatched = false;
  const models = {
    streamSimple(_model: Model<"openai-responses">, request: Context) {
      dispatched = true;
      const payload = convertResponsesMessages(model, request, new Set([model.provider]));
      const calls = payload.filter((item) => item.type === "function_call");
      const outputs = payload.filter((item) => item.type === "function_call_output");
      expect(outputs.map((item) => item.call_id)).toEqual(calls.map((item) => item.call_id));
      expect(calls.map((item) => item.call_id)).toEqual(["call_read", "call_cancelled"]);
      expect(outputs.map((item) => item.output)).toEqual(["Original", "Interrupted by user"]);
      expect(payload.filter((item) => "role" in item && item.role === "user")).toHaveLength(3);
      expect(payload.at(-1)).toMatchObject({ role: "user", content: [{ type: "input_text", text: "Continue" }] });
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: continued });
      return stream;
    },
  } as unknown as Models;
  const result = await new PiModelClient(models, model).stream(context, {
    signal: new AbortController().signal, maxRetries: 0,
  });
  expect(dispatched).toBe(true);
  expect(result).toEqual(continued);
  expect(context).toEqual(original);
});
