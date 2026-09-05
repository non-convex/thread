import assert from "node:assert/strict";
import test from "node:test";
import { createWebSearchTool } from "../src/tools/web.js";
import type { ToolContext } from "../src/tools/types.js";

const context: ToolContext = {
  rootPath: process.cwd(), signal: new AbortController().signal,
  invocation: { executionId: "e", assistantEntryId: "a", toolCallId: "t" },
};

async function search(payload: unknown, sse = false) {
  const json = JSON.stringify(payload);
  const body = sse ? `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: ${json}\n\n` : json;
  return createWebSearchTool({
    env: {}, fetch: async () => new Response(body, { headers: { "content-type": sse ? "text/event-stream" : "application/json" } }),
  }).execute({ query: "test" }, context);
}

for (const sse of [false, true]) {
  test(`websearch preserves RPC and tool failures (${sse ? "SSE" : "JSON"})`, async () => {
    const rpc = await search({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "upstream unavailable" } }, sse);
    assert.equal(rpc.isError, true);
    assert.match(rpc.content, /upstream unavailable/);
    assert.doesNotMatch(rpc.content, /No search results/);
    const tool = await search({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [
      { type: "text", text: "rate limit exceeded" }, { type: "text", text: "retry later" },
    ] } }, sse);
    assert.equal(tool.isError, true);
    assert.match(tool.content, /rate limit exceeded/);
    assert.match(tool.content, /retry later/);
    const noContent = await search({ result: { isError: true } }, sse);
    assert.equal(noContent.isError, true);
    assert.match(noContent.content, /tool error/);
  });

  test(`websearch keeps every text block and accepts a successful empty result (${sse ? "SSE" : "JSON"})`, async () => {
    const multiple = await search({ jsonrpc: "2.0", id: 1, result: { content: [
      { type: "text", text: "first source" }, { type: "image", data: "unused" }, { type: "text", text: "第二个来源" },
    ] } }, sse);
    assert.equal(multiple.isError, false);
    assert.equal(multiple.content, "first source\n\n第二个来源");
    const empty = await search({ jsonrpc: "2.0", id: 1, result: { content: [] } }, sse);
    assert.equal(empty.isError, false);
    assert.match(empty.content, /No search results found/);
  });
}

test("websearch does not report malformed responses as empty searches", async () => {
  for (const payload of [{}, { result: null }, { result: {} }]) {
    const result = await search(payload);
    assert.equal(result.isError, true);
    assert.match(result.content, /Invalid web search/);
  }
});
