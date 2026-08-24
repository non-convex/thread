import assert from "node:assert/strict";
import test from "node:test";
import { registerBuiltinTools } from "../../src/tools/builtins.js";
import { ToolRegistry } from "../../src/tools/types.js";
import {
  WEB_FETCH_RESPONSE_LIMIT_BYTES,
  convertHtmlToMarkdown,
  createWebFetchTool,
  createWebSearchTool,
  extractTextFromHtml,
  parseMcpSearchResponse,
  selectWebSearchProvider,
  type WebToolFetch,
} from "../../src/tools/web.js";

const context = {
  rootPath: process.cwd(),
  signal: new AbortController().signal,
};

test("web tools are registered as builtins", () => {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  assert.ok(registry.get("websearch"));
  assert.ok(registry.get("webfetch"));
});

test("websearch selects its provider and parses JSON or SSE MCP results", () => {
  assert.equal(selectWebSearchProvider({}), "exa");
  assert.equal(selectWebSearchProvider({ THREAD_WEBSEARCH_PROVIDER: "parallel" }), "parallel");
  assert.throws(() => selectWebSearchProvider({ THREAD_WEBSEARCH_PROVIDER: "unknown" }), /exa or parallel/);

  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "current result" }] },
  });
  assert.equal(parseMcpSearchResponse(payload), "current result");
  assert.equal(parseMcpSearchResponse(`event: message\ndata: ${payload}\n\n`), "current result");
});

test("websearch sends an Exa MCP tool call and returns its model-visible text", async () => {
  let requestedUrl = "";
  let requestedBody = "";
  const fetchImpl: WebToolFetch = async (input, init) => {
    requestedUrl = String(input);
    requestedBody = typeof init?.body === "string" ? init.body : "";
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "- [Thread](https://example.com/thread)" }] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const tool = createWebSearchTool({
    fetch: fetchImpl,
    env: { THREAD_WEBSEARCH_PROVIDER: "exa", EXA_API_KEY: "test-key" },
  });
  const result = await tool.execute({ query: "thread harness", numResults: 3 }, context);

  assert.equal(result.isError, false);
  assert.match(result.content, /example\.com\/thread/);
  assert.equal(new URL(requestedUrl).searchParams.get("exaApiKey"), "test-key");
  const request = JSON.parse(requestedBody) as {
    method: string;
    params: { name: string; arguments: { query: string; numResults: number } };
  };
  assert.equal(request.method, "tools/call");
  assert.equal(request.params.name, "web_search_exa");
  assert.deepEqual(request.params.arguments, {
    query: "thread harness",
    type: "auto",
    numResults: 3,
    livecrawl: "fallback",
  });
});

test("webfetch converts HTML to Markdown or text and rejects oversized responses", async () => {
  const html = "<html><body><h1>Title</h1><script>secret()</script><p>Hello <b>web</b>.</p></body></html>";
  assert.match(convertHtmlToMarkdown(html), /^# Title/m);
  assert.doesNotMatch(convertHtmlToMarkdown(html), /secret/);
  assert.equal(extractTextFromHtml(html), "TitleHello web.");

  const fetchImpl: WebToolFetch = async () =>
    new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  const tool = createWebFetchTool({ fetch: fetchImpl });
  const markdown = await tool.execute({ url: "https://example.com/page" }, context);
  assert.equal(markdown.isError, false);
  assert.match(markdown.content, /^# Title/m);
  assert.doesNotMatch(markdown.content, /secret/);

  const text = await tool.execute({ url: "https://example.com/page", format: "text" }, context);
  assert.equal(text.content, "TitleHello web.");

  const oversized = createWebFetchTool({
    fetch: async () =>
      new Response("small", {
        status: 200,
        headers: {
          "content-type": "text/plain",
          "content-length": String(WEB_FETCH_RESPONSE_LIMIT_BYTES + 1),
        },
      }),
  });
  const rejected = await oversized.execute({ url: "https://example.com/large" }, context);
  assert.equal(rejected.isError, true);
  assert.match(rejected.content, /Response too large/);
});
