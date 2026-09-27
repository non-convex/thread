import type { ThreadRuntime } from "../../core/runtime/thread-runtime.js";
import { viewResult, type CommandResult } from "./types.js";

export async function mcpCommand(args: string[], runtime: ThreadRuntime, signal: AbortSignal): Promise<CommandResult> {
  signal.throwIfAborted();
  const reconnect = args.length === 2 && args[0] === "reconnect";
  if (args.length && !reconnect) throw new Error("Usage: /mcp or /mcp reconnect <server>");
  if (reconnect) await runtime.reconnectMcpServer(args[1]!, { signal });
  const servers = runtime.mcpServers;
  const content = [
    servers.length ? servers.map((server) => [
      `${server.name} · ${server.transport} · ${server.status} · ${server.tools.length} tools`,
      ...(server.error ? [`  error: ${server.error}`] : []),
      ...server.tools.map((name) => `  ${name}`),
      ...(server.stderr ? [`  stderr (recent):\n${server.stderr}`] : []),
    ].join("\n")).join("\n\n") : "No MCP servers configured. Add mcpServers to your Thread config and restart.",
    "Use /mcp reconnect <server> while idle. Configuration changes require a restart.",
    "MCP effects are external: file edits are not captured by rewind, and cancellation does not undo remote operations.",
  ].join("\n\n");
  return viewResult(content, { type: "document", title: "MCP servers", content }, reconnect);
}
