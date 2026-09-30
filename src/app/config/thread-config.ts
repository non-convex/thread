import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CacheRetention, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getThreadHome } from "../../core/config/home.js";
import { resolveConfigValue } from "../../core/config/config-value.js";
import type { McpServers } from "../../core/mcp/client.js";
import type { CustomProviderConfig, ModelOverrideConfig, ModelSelectionConfig } from "../../core/config/model-config.js";
import { parseConfig } from "./config-parser.js";

export const DEFAULT_THREAD_CONFIG_FILE = "config.json";

export interface WorkerConfig {
  model: ModelSelectionConfig;
  thinkingLevel: ModelThinkingLevel;
  maxSteps: number;
  maxRuntimeMinutes: number;
  maxRevisions: number;
}

export interface DreamerConfig {
  model: ModelSelectionConfig;
  thinkingLevel: ModelThinkingLevel;
  idleTurns?: number;
  idleMinutes?: number;
  maxWaitMinutes?: number;
  maxSteps?: number;
  maxRuntimeMinutes?: number;
}

export interface AttributionConfig {
  /** Empty disables the commit trailer. */
  commit: string;
}

export interface ThreadConfig {
  search?: { semantic: boolean };
  mcpServers?: McpServers;
  model?: ModelSelectionConfig;
  agents: {
    worker?: WorkerConfig;
    dreamer?: DreamerConfig;
  };
  defaultThinkingLevel?: ModelThinkingLevel;
  /** Provider cache lifetime; omitted uses the provider default. */
  cacheRetention?: CacheRetention;
  attribution?: AttributionConfig;
  modelOverrides?: Record<string, ModelOverrideConfig>;
  providers: Record<string, CustomProviderConfig>;
}

export interface LoadedThreadConfig {
  path: string;
  config: ThreadConfig;
  agentDiagnostics: string[];
}

export function getDefaultThreadConfigPath(): string {
  return path.join(getThreadHome(), DEFAULT_THREAD_CONFIG_FILE);
}

export async function loadThreadConfig(configuredPath?: string): Promise<LoadedThreadConfig | undefined> {
  const configPath = configuredPath ? path.resolve(configuredPath) : getDefaultThreadConfigPath();
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && configuredPath === undefined) {
      return undefined;
    }
    throw new Error(`Cannot read Thread config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Cannot parse Thread config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const loaded = parseConfig(parsed);
    // Only user configuration resolves environment references; the embedded runtime receives literal values.
    for (const [name, server] of Object.entries(loaded.config.mcpServers ?? {})) {
      if (server.enabled === false) continue;
      const field = server.transport === "stdio" ? "env" : "headers";
      const values = server.transport === "stdio" ? server.env : server.headers;
      if (!values) continue;
      const resolved: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) {
        // MCP configuration supports environment substitution, not shell credential commands.
        const result = value.startsWith("!") ? value : await resolveConfigValue(value, async (name) => process.env[name]);
        if (result === undefined) throw new Error(`Missing environment variable in mcpServers.${name}.${field}.${key}`);
        resolved[key] = result;
      }
      if (server.transport === "stdio") server.env = resolved;
      else server.headers = resolved;
    }
    return { path: configPath, ...loaded };
  } catch (error) {
    throw new Error(`Invalid Thread config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
