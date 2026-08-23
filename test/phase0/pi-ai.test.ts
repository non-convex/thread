import assert from "node:assert/strict";
import test from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
} from "@earendil-works/pi-ai";

test("pi-ai faux provider supports streaming, tools, usage and one-shot calls", async () => {
  const faux = fauxProvider({ tokenSize: { min: 1, max: 1 } });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("semantic result"),
  ]);
  const context: Context = {
    systemPrompt: "test",
    messages: [{ role: "user", content: "inspect", timestamp: Date.now() }],
    tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }],
  };

  const events: string[] = [];
  const stream = models.streamSimple(faux.getModel(), context);
  for await (const event of stream) events.push(event.type);
  const first = await stream.result();
  assert.equal(first.stopReason, "toolUse");
  assert.ok(first.usage.totalTokens > 0);
  assert.ok(events.includes("toolcall_end"));

  const semantic = await models.completeSimple(faux.getModel(), {
    messages: [{ role: "user", content: "summarize", timestamp: Date.now() }],
  });
  assert.equal(semantic.stopReason, "stop");
  assert.equal(semantic.content[0]?.type, "text");
  assert.equal(semantic.content[0]?.type === "text" ? semantic.content[0].text : undefined, "semantic result");
});

test("pi-ai stream reports cancellation without throwing", async () => {
  const faux = fauxProvider({ tokensPerSecond: 1, tokenSize: { min: 1, max: 1 } });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("this response is deliberately long enough to cancel")]);
  const controller = new AbortController();
  const stream = models.streamSimple(
    faux.getModel(),
    { messages: [{ role: "user", content: "cancel", timestamp: Date.now() }] },
    { signal: controller.signal },
  );
  for await (const event of stream) {
    if (event.type === "start") controller.abort(new Error("cancelled"));
  }
  const message = await stream.result();
  assert.equal(message.stopReason, "aborted");
});
