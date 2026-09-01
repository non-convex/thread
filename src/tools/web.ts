import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import { Type } from "@earendil-works/pi-ai";
import { singletonResource } from "./execution.js";
import type { AgentTool, ToolResult } from "./types.js";

export const WEB_SEARCH_DEFAULT_RESULTS = 8;
export const WEB_SEARCH_MAX_RESULTS = 20;
export const WEB_SEARCH_MAX_CONTEXT_CHARACTERS = 50_000;
export const WEB_SEARCH_RESPONSE_LIMIT_BYTES = 256 * 1024;
export const WEB_SEARCH_TIMEOUT_MS = 25_000;
export const WEB_FETCH_RESPONSE_LIMIT_BYTES = 5 * 1024 * 1024;
export const WEB_FETCH_OUTPUT_LIMIT_CHARACTERS = 200_000;
export const WEB_FETCH_DEFAULT_TIMEOUT_SECONDS = 30;
export const WEB_FETCH_MAX_TIMEOUT_SECONDS = 120;

const EXA_URL = "https://mcp.exa.ai/mcp";
const PARALLEL_URL = "https://search.parallel.ai/mcp";
const USER_AGENT = "thread/0.1.0";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export type WebSearchProvider = "exa" | "parallel";
export type WebFetchFormat = "text" | "markdown" | "html";

type WebSearchArgs = {
  query: string;
  numResults?: number;
  livecrawl?: "fallback" | "preferred";
  type?: "auto" | "fast" | "deep";
  contextMaxCharacters?: number;
}

type WebFetchArgs = {
  url: string;
  format?: WebFetchFormat;
  timeout?: number;
}

export type WebToolFetch = (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => Promise<Response>;

interface WebToolOptions {
  fetch?: WebToolFetch;
  env?: NodeJS.ProcessEnv;
}

function ok(content: string, details?: unknown): ToolResult {
  return { content, isError: false, ...(details === undefined ? {} : { details }) };
}

function fail(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true };
}

function requireNonBlank(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty`);
  return trimmed;
}

function parseMcpPayload(payload: string): string | undefined {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) return undefined;
  const parsed = JSON.parse(trimmed) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("result" in parsed)) return undefined;
  const result = parsed.result;
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
    return undefined;
  }
  for (const item of result.content) {
    if (typeof item !== "object" || item === null || !("text" in item)) continue;
    if (typeof item.text === "string" && item.text) return item.text;
  }
  return undefined;
}

export function parseMcpSearchResponse(body: string): string | undefined {
  const direct = body.trim() ? parseMcpPayload(body) : undefined;
  if (direct) return direct;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = parseMcpPayload(line.slice(5));
    if (data) return data;
  }
  return undefined;
}

export function selectWebSearchProvider(env: NodeJS.ProcessEnv = process.env): WebSearchProvider {
  const configured = env.THREAD_WEBSEARCH_PROVIDER?.trim().toLowerCase();
  if (!configured) return "exa";
  if (configured === "exa" || configured === "parallel") return configured;
  throw new Error(`THREAD_WEBSEARCH_PROVIDER must be exa or parallel, got ${configured}`);
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Response too large (exceeds ${maxBytes} bytes)`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Response too large (exceeds ${maxBytes} bytes)`);
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function searchRequest(provider: WebSearchProvider, args: WebSearchArgs, env: NodeJS.ProcessEnv) {
  if (provider === "parallel") {
    return {
      url: PARALLEL_URL,
      tool: "web_search",
      headers: {
        ...(env.PARALLEL_API_KEY ? { Authorization: `Bearer ${env.PARALLEL_API_KEY}` } : {}),
      },
      arguments: {
        objective: args.query,
        search_queries: [args.query],
      },
    };
  }
  const url = new URL(EXA_URL);
  if (env.EXA_API_KEY) url.searchParams.set("exaApiKey", env.EXA_API_KEY);
  return {
    url: url.toString(),
    tool: "web_search_exa",
    headers: {},
    arguments: {
      query: args.query,
      type: args.type ?? "auto",
      numResults: args.numResults ?? WEB_SEARCH_DEFAULT_RESULTS,
      livecrawl: args.livecrawl ?? "fallback",
      ...(args.contextMaxCharacters === undefined ? {} : { contextMaxCharacters: args.contextMaxCharacters }),
    },
  };
}

export function createWebSearchTool(options: WebToolOptions = {}): AgentTool<WebSearchArgs> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const env = options.env ?? process.env;
  return {
    name: "websearch",
    description:
      "Search the web for current information through Exa or Parallel. Returns provider-formatted results and source URLs.",
    parameters: Type.Object({
      query: Type.String({ description: "Web search query." }),
      numResults: Type.Optional(
        Type.Integer({ minimum: 1, maximum: WEB_SEARCH_MAX_RESULTS, description: "Result count; defaults to 8." }),
      ),
      livecrawl: Type.Optional(
        Type.Union([Type.Literal("fallback"), Type.Literal("preferred")], {
          description: "Use live crawling as a fallback or prefer it over cached content.",
        }),
      ),
      type: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("fast"), Type.Literal("deep")], {
          description: "Search depth; defaults to auto.",
        }),
      ),
      contextMaxCharacters: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: WEB_SEARCH_MAX_CONTEXT_CHARACTERS,
          description: "Maximum provider context characters; defaults to 10000.",
        }),
      ),
    }),
    replay: "never",
    execution: {
      effect: "read",
      mode: "parallel",
      resources: (args) => singletonResource("network", `search:${args.query.trim()}`, "read"),
    },
    async execute(args, context) {
      try {
        context.signal.throwIfAborted();
        const query = requireNonBlank(args.query, "query");
        const provider = selectWebSearchProvider(env);
        const request = searchRequest(provider, { ...args, query }, env);
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS)]);
        const response = await fetchImpl(request.url, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            ...request.headers,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: request.tool, arguments: request.arguments },
          }),
        });
        if (!response.ok) throw new Error(`${provider} web search failed with HTTP ${response.status}`);
        const body = (await readBoundedBody(response, WEB_SEARCH_RESPONSE_LIMIT_BYTES, signal)).toString("utf8");
        const result = parseMcpSearchResponse(body);
        return ok(result ?? "No search results found. Try a different query.", { provider, query });
      } catch (error) {
        return fail(error);
      }
    },
  };
}

function acceptHeader(format: WebFetchFormat): string {
  if (format === "markdown") {
    return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
  }
  if (format === "text") return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
  return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1";
}

function textualMime(mime: string): boolean {
  return (
    !mime ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/javascript" ||
    mime === "application/x-javascript"
  );
}

export function extractTextFromHtml(html: string): string {
  let text = "";
  let skippedDepth = 0;
  const skipped = new Set(["script", "style", "noscript", "iframe", "object", "embed"]);
  const parser = new Parser({
    onopentag(name) {
      if (skippedDepth > 0 || skipped.has(name)) skippedDepth++;
    },
    ontext(value) {
      if (skippedDepth === 0) text += value;
    },
    onclosetag() {
      if (skippedDepth > 0) skippedDepth--;
    },
  });
  parser.write(html);
  parser.end();
  return text.trim();
}

export function convertHtmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  turndown.remove(["script", "style", "noscript", "iframe", "object", "embed", "meta", "link"]);
  return turndown.turndown(html);
}

function limitedCharacters(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum)}\n[content truncated at ${maximum} characters]`;
}

export function createWebFetchTool(options: WebToolOptions = {}): AgentTool<WebFetchArgs> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return {
    name: "webfetch",
    description:
      "Fetch an HTTP(S) URL and return text, Markdown, or HTML. Prefer websearch first when the URL is unknown.",
    parameters: Type.Object({
      url: Type.String({ description: "Fully qualified HTTP(S) URL." }),
      format: Type.Optional(
        Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")], {
          description: "Output format; defaults to markdown.",
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: WEB_FETCH_MAX_TIMEOUT_SECONDS,
          description: "Request timeout in seconds; defaults to 30 and cannot exceed 120.",
        }),
      ),
    }),
    replay: "never",
    execution: {
      effect: "read",
      mode: "parallel",
      resources: (args) => singletonResource("network", args.url.trim(), "read"),
    },
    async execute(args, context) {
      try {
        context.signal.throwIfAborted();
        const url = new URL(requireNonBlank(args.url, "url"));
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          throw new Error("URL must use http:// or https://");
        }
        if (url.username || url.password) throw new Error("URL credentials are not allowed");
        const format = args.format ?? "markdown";
        const timeoutSeconds = args.timeout ?? WEB_FETCH_DEFAULT_TIMEOUT_SECONDS;
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(Math.floor(timeoutSeconds * 1_000))]);
        const headers = {
          "User-Agent": BROWSER_USER_AGENT,
          Accept: acceptHeader(format),
          "Accept-Language": "en-US,en;q=0.9",
        };
        let response = await fetchImpl(url, { headers, redirect: "follow", signal });
        if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
          response = await fetchImpl(url, {
            headers: { ...headers, "User-Agent": USER_AGENT },
            redirect: "follow",
            signal,
          });
        }
        if (!response.ok) throw new Error(`Web fetch failed with HTTP ${response.status}`);
        const finalUrl = new URL(response.url || url);
        if (finalUrl.protocol !== "http:" && finalUrl.protocol !== "https:") {
          throw new Error(`Fetch redirected to unsupported protocol ${finalUrl.protocol}`);
        }
        const contentType = response.headers.get("content-type") ?? "";
        const mime = contentType.split(";", 1)[0]!.trim().toLowerCase();
        if (!textualMime(mime)) throw new Error(`Unsupported fetched content type: ${mime || "unknown"}`);
        const body = await readBoundedBody(response, WEB_FETCH_RESPONSE_LIMIT_BYTES, signal);
        const content = new TextDecoder().decode(body);
        const output = contentType.toLowerCase().includes("text/html")
          ? format === "markdown"
            ? convertHtmlToMarkdown(content)
            : format === "text"
              ? extractTextFromHtml(content)
              : content
          : content;
        return ok(limitedCharacters(output, WEB_FETCH_OUTPUT_LIMIT_CHARACTERS), {
          url: finalUrl.toString(),
          contentType,
          format,
        });
      } catch (error) {
        return fail(error);
      }
    },
  };
}

export const webSearchTool = createWebSearchTool();
export const webFetchTool = createWebFetchTool();
