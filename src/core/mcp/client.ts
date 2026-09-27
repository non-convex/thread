import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { Client, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { AgentTool } from "../tools/types.js";
import { limited } from "../tools/results.js";
import { createMcpTool } from "./tools.js";

interface McpServerOptions {
  enabled?: boolean;
  /** Omitted allows all tools from this explicitly trusted server. Empty allows none. */
  enabledTools?: readonly string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  /** HTTP defaults to auto; stdio to legacy to avoid an extra probe subprocess. */
  protocol?: "auto" | "legacy";
}

export type McpServerConfig = McpServerOptions & (
  | { transport: "stdio"; command: string; args?: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>> }
  | { transport: "http"; url: string; headers?: Readonly<Record<string, string>> }
);
export type McpServers = Readonly<Record<string, McpServerConfig>>;
export interface McpServerStatus {
  name: string;
  transport: McpServerConfig["transport"];
  status: "disabled" | "connecting" | "connected" | "failed";
  tools: string[];
  error?: string;
  /** Bounded, credential-redacted stderr tail. Never appended to model instructions. */
  stderr?: string;
}

const STARTUP_TIMEOUT = 10_000;
const TOOL_TIMEOUT = 60_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_TOOLS = 512;
// SDK v2 forwards per-request HTTP aborts only in the modern protocol era.
// Carry the owning operation's signal into legacy POSTs without mutating a shared client.
const httpRequestSignal = new AsyncLocalStorage<AbortSignal>();

/** Validate both JSON configuration and untyped embedding callers before starting processes. */
export function parseMcpServers(value: unknown): McpServers {
  const object = (input: unknown, label: string): Record<string, unknown> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(`${label} must be an object`);
    return input as Record<string, unknown>;
  };
  const record = object(value, "mcpServers");
  for (const [name, value] of Object.entries(record)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error("MCP server IDs must use 1–64 letters, digits, underscores or hyphens");
    const input = object(value, `mcpServers.${name}`);
    const invalid = (field: string): never => { throw new Error(`Invalid mcpServers.${name}.${field}`); };
    const allowed = new Set(["transport", "enabled", "enabledTools", "startupTimeoutMs", "toolTimeoutMs", "protocol",
      ...(input.transport === "stdio" ? ["command", "args", "cwd", "env"] : ["url", "headers"])]);
    for (const key of Object.keys(input)) if (!allowed.has(key)) invalid(key);
    if (input.transport !== "stdio" && input.transport !== "http") invalid("transport");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") invalid("enabled");
    if (input.protocol !== undefined && input.protocol !== "auto" && input.protocol !== "legacy") invalid("protocol");
    for (const key of ["startupTimeoutMs", "toolTimeoutMs"]) {
      if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || (input[key] as number) <= 0 || (input[key] as number) > 2_147_483_647)) invalid(key);
    }
    for (const key of ["enabledTools", "args"]) {
      if (input[key] !== undefined && (!Array.isArray(input[key]) || (input[key] as unknown[]).some((item) => typeof item !== "string"))) invalid(key);
    }
    for (const key of ["env", "headers"]) {
      if (input[key] === undefined) continue;
      for (const [field, item] of Object.entries(object(input[key], `mcpServers.${name}.${key}`))) {
        if (typeof item !== "string" || !field.trim() || field.includes("\0") || item.includes("\0")) invalid(key);
        if (key === "env" && field.includes("=")) invalid(key);
        if (key === "headers") {
          try { new Headers({ [field]: item as string }); } catch { invalid(key); }
        }
      }
    }
    if (input.transport === "stdio") {
      if (typeof input.command !== "string" || !input.command.trim() || input.command.includes("\0")) invalid("command");
      if (input.cwd !== undefined && (typeof input.cwd !== "string" || !input.cwd.trim())) invalid("cwd");
    } else {
      if (typeof input.url !== "string") invalid("url");
      try {
        const url = new URL(input.url as string);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) invalid("url");
        if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) invalid("url (HTTP is limited to loopback)");
      } catch { invalid("url (use HTTPS, or HTTP on loopback, without credentials or fragments)"); }
    }
  }
  return structuredClone(record) as Record<string, McpServerConfig>;
}

interface Connection {
  config: McpServerConfig;
  state: McpServerStatus;
  client?: Client;
  transport?: StdioClientTransport | StreamableHTTPClientTransport;
  tools: AgentTool[];
}

/** One client per configured server, owned by exactly one runtime. No persisted sessions or call retries. */
export class McpClients {
  private readonly connections = new Map<string, Connection>();
  private closed = false;

  constructor(private readonly rootPath: string, configs: McpServers) {
    for (const [name, config] of Object.entries(configs).sort(([a], [b]) => a.localeCompare(b))) {
      this.connections.set(name, { config, tools: [], state: {
        name, transport: config.transport, status: config.enabled === false ? "disabled" : "connecting", tools: [],
      } });
    }
  }

  async open(): Promise<void> {
    const outcomes = await Promise.allSettled([...this.connections.values()].map((entry) => this.connect(entry)));
    const failed = outcomes.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  status(): McpServerStatus[] {
    return structuredClone([...this.connections.values()].map((entry) => entry.state));
  }

  tools(): AgentTool[] {
    return [...this.connections.values()].flatMap((entry) => entry.state.status === "connected" ? entry.tools : []);
  }

  async reconnect(name: string, signal: AbortSignal): Promise<void> {
    const entry = this.connections.get(name);
    if (!entry) throw new Error(`Unknown MCP server: ${name}`);
    signal.throwIfAborted();
    await this.disconnect(entry);
    signal.throwIfAborted();
    await this.connect(entry, signal);
  }

  /** Called only at a turn boundary. SDK TTLs and list-change invalidation decide whether to refetch. */
  async refresh(signal: AbortSignal): Promise<void> {
    const outcomes = await Promise.allSettled([...this.connections.values()].map(async (entry) => {
      if (entry.state.status !== "connected") return;
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(entry.config.startupTimeoutMs ?? STARTUP_TIMEOUT)]);
      try { await this.discover(entry, bounded); }
      catch (error) {
        entry.tools = [];
        entry.state.tools = [];
        entry.state.error = this.message(entry, error);
        // Caller cancellation does not make the server unusable; the next turn can discover again.
        if (!signal.aborted) { entry.state.status = "failed"; await this.disconnect(entry); }
      }
    }));
    signal.throwIfAborted();
    const failed = outcomes.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  private async connect(entry: Connection, parent?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error("MCP clients are closed");
    if (entry.config.enabled === false) return;
    const config = entry.config;
    entry.state.status = "connecting";
    delete entry.state.error;
    delete entry.state.stderr;
    const timeout = config.startupTimeoutMs ?? STARTUP_TIMEOUT;
    const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(parent ? [parent] : [])]);
    const client = new Client({ name: "thread", version: "0.1.0" }, {
      capabilities: {}, inputRequired: { autoFulfill: false }, listMaxPages: 16,
      versionNegotiation: { mode: config.protocol ?? (config.transport === "http" ? "auto" : "legacy"), probe: { maxRetries: 0 } },
      listChanged: { tools: { autoRefresh: false, onChanged: () => {} } },
    });
    entry.client = client;
    client.onerror = (error) => { if (entry.client === client) entry.state.error = this.message(entry, error); };
    client.onclose = () => {
      if (entry.client !== client) return;
      entry.state.status = "failed";
      entry.state.error ??= "Connection closed. Reconnect this MCP server before calling it again.";
      entry.tools = [];
      entry.state.tools = [];
    };
    try {
      const transport = config.transport === "stdio"
        ? new StdioClientTransport({ command: config.command, args: [...config.args ?? []],
          cwd: path.resolve(this.rootPath, config.cwd ?? "."), env: { ...config.env }, stderr: "pipe", maxBufferSize: MAX_RESPONSE_BYTES })
        : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: { ...config.headers }, redirect: "error" },
          fetch: boundedFetch, onInsufficientScope: "throw",
          reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 30_000, reconnectionDelayGrowFactor: 1.5 },
        });
      entry.transport = transport;
      if (transport instanceof StdioClientTransport) transport.stderr?.on("data", (chunk: Buffer) => {
        // Keep draining even when the diagnostic tail is full; an unread pipe can block the server.
        entry.state.stderr = this.message(entry, Buffer.from((entry.state.stderr ?? "") + chunk.toString("utf8")).subarray(-4096).toString("utf8"));
      });
      await httpRequestSignal.run(signal, () => client.connect(transport, { signal, timeout }));
      signal.throwIfAborted();
      await this.discover(entry, signal);
      signal.throwIfAborted();
      if (!client.transport) throw new Error("MCP connection closed during discovery");
      entry.state.status = "connected";
    } catch (error) {
      entry.state.status = "failed";
      entry.state.error = this.message(entry, error);
      await this.disconnect(entry);
      parent?.throwIfAborted();
    }
  }

  private async discover(entry: Connection, signal: AbortSignal): Promise<void> {
    const client = entry.client!;
    const definitions = client.getServerCapabilities()?.tools
      ? (await httpRequestSignal.run(signal, () => client.listTools(undefined, {
        signal, timeout: entry.config.startupTimeoutMs ?? STARTUP_TIMEOUT,
      }))).tools : [];
    signal.throwIfAborted();
    if (definitions.length > MAX_TOOLS || Buffer.byteLength(JSON.stringify(definitions)) > MAX_CATALOG_BYTES) {
      throw new Error("MCP tool catalog exceeds 512 tools or 1 MiB; narrow the server's advertised catalog");
    }
    const allowed = entry.config.enabledTools ? new Set(entry.config.enabledTools) : undefined;
    const names = new Set<string>();
    const tools = definitions.filter((tool) => !allowed || allowed.has(tool.name))
      .sort((a, b) => a.name.localeCompare(b.name)).map((definition: Tool) => {
        const tool = createMcpTool(entry.state.name, definition, async (args, parent) => {
          if (this.closed || entry.client !== client || entry.state.status !== "connected") throw new Error(`MCP server ${entry.state.name} is unavailable; use /mcp reconnect ${entry.state.name}`);
          const timeout = entry.config.toolTimeoutMs ?? TOOL_TIMEOUT;
          const signal = AbortSignal.any([parent, AbortSignal.timeout(timeout)]);
          try {
            // Supplying the captured definition also disables the SDK's header-mismatch refetch/replay.
            const result = await httpRequestSignal.run(signal, () => client.callTool({ name: definition.name, arguments: args }, {
              signal, timeout, maxTotalTimeout: timeout, toolDefinition: definition,
            }));
            signal.throwIfAborted();
            return result;
          } catch (error) {
            parent.throwIfAborted();
            entry.state.error = this.message(entry, error);
            throw new Error(`MCP ${entry.state.name}/${definition.name}: ${entry.state.error}`);
          }
        });
        if (names.has(tool.name)) throw new Error(`Duplicate MCP tool name: ${tool.name}`);
        names.add(tool.name);
        return tool;
      });
    if (!client.transport) throw new Error("MCP connection closed during discovery");
    entry.tools = tools;
    entry.state.tools = tools.map((tool) => tool.name);
  }

  private message(entry: Connection, error: unknown): string {
    let text = error instanceof Error ? error.message : String(error);
    const values = Object.values(entry.config.transport === "stdio" ? entry.config.env ?? {} : entry.config.headers ?? {});
    const secrets = values.flatMap((value) => /^Bearer\s+/i.test(value) ? [value, value.replace(/^Bearer\s+/i, "")] : [value])
      .filter(Boolean).sort((a, b) => b.length - a.length);
    for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
    text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
    if (error instanceof Error && /\b401\b|\b403\b|unauthorized|authentication|insufficient.scope/i.test(text)) {
      text = `Authentication failed. Check configured credentials; interactive MCP OAuth is not supported. ${text}`;
    }
    return limited(text, 4096);
  }

  private async disconnect(entry: Connection): Promise<void> {
    const client = entry.client;
    const transport = entry.transport;
    delete entry.client;
    delete entry.transport;
    if (entry.state.status !== "disabled") entry.state.status = "failed";
    entry.tools = [];
    entry.state.tools = [];
    try {
      if (transport instanceof StreamableHTTPClientTransport) await transport.terminateSession();
    } catch (error) { entry.state.error ??= this.message(entry, error); }
    finally {
      // Also close a transport whose connect() failed before the SDK took ownership.
      try { await client?.close(); } finally { await transport?.close(); }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const outcomes = await Promise.allSettled([...this.connections.values()].map((entry) => this.disconnect(entry)));
    const failures = outcomes.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((item) => item.reason), "Failed to close MCP clients");
  }
}

/** Bound the wire response too, rather than truncating only after JSON/base64 has been decoded. */
async function boundedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  let owner: AbortSignal | undefined;
  if (init?.method === "POST" && typeof init.body === "string") {
    const method = (JSON.parse(init.body) as { method?: string }).method;
    // Subscriptions outlive the operation that opened them. Cancellation notifications
    // must still be sent after that operation aborts, but may not hang shutdown.
    if (method?.startsWith("notifications/")) owner = AbortSignal.timeout(2000);
    else if (method !== "subscriptions/listen") owner = httpRequestSignal.getStore();
  }
  if (init?.method === "DELETE") owner = AbortSignal.timeout(2000);
  const signals = [...(init?.signal ? [init.signal] : []), ...(owner ? [owner] : [])];
  const response = await fetch(input, { ...init, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}), redirect: "error" });
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new Error(`MCP HTTP ${response.status}: authentication required or access denied`);
  }
  if (!response.body) return response;
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("MCP response exceeds 10 MiB");
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
