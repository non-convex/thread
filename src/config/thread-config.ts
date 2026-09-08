import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { CacheRetention, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

import { object, parseConfig, parsePiModelOverrides, parseProvider, thinkingLevel } from "./config-parser.js";

export const DEFAULT_THREAD_HOME_NAME = ".thread";
export const DEFAULT_THREAD_CONFIG_FILE = "config.json";

export type SupportedCustomApi = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface ModelSelectionConfig {
  provider: string;
  id: string;
}

export interface CustomModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: ThinkingLevelMap;
  samplingParams?: Record<string, unknown>;
  compat?: Record<string, unknown>;
}

export interface CustomProviderConfig {
  name: string;
  api: SupportedCustomApi;
  baseUrl: string;
  apiKeyEnv?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models: CustomModelConfig[];
}

/** Local metadata overrides keyed by `<provider>/<model-id>`. */
export interface ModelOverrideConfig {
  contextWindow: number;
}

export interface ImplementationWorkerConfig {
  model: ModelSelectionConfig;
  thinkingLevel: ModelThinkingLevel;
  maxConcurrent: number;
  maxSteps: number;
  maxRuntimeMinutes: number;
  maxRevisions: number;
}

export interface DreamerConfig {
  model: ModelSelectionConfig;
  thinkingLevel: ModelThinkingLevel;
}

export interface AttributionConfig {
  /** Empty disables the commit trailer. */
  commit: string;
}

export interface ThreadConfig {
  search?: { semantic: boolean };
  model?: ModelSelectionConfig;
  agents: {
    "implementation-worker"?: ImplementationWorkerConfig;
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
  source: "thread" | "pi";
  config: ThreadConfig;
  agentDiagnostics: string[];
}

export function getThreadHome(): string {
  const configured = process.env.THREAD_HOME;
  return configured ? path.resolve(configured) : path.join(homedir(), DEFAULT_THREAD_HOME_NAME);
}

export function getDefaultThreadConfigPath(): string {
  return path.join(getThreadHome(), DEFAULT_THREAD_CONFIG_FILE);
}

export function getPiAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured ? path.resolve(configured) : path.join(homedir(), ".pi", "agent");
}

async function readJson(filePath: string, label: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Cannot parse ${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isMissingFileError(error: unknown): boolean {
  return (error as { cause?: NodeJS.ErrnoException }).cause?.code === "ENOENT";
}

async function loadPiThreadConfig(): Promise<LoadedThreadConfig | undefined> {
  const piDir = getPiAgentDir();
  const modelsPath = path.join(piDir, "models.json");
  let parsed: unknown;
  try {
    parsed = await readJson(modelsPath, "pi model config");
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
  try {
    const input = object(parsed, "pi models config");
    const providers: Record<string, CustomProviderConfig> = {};
    const modelOverrides: Record<string, ModelOverrideConfig> = {};
    for (const [providerId, provider] of Object.entries(object(input.providers, "providers"))) {
      const providerInput = object(provider, `providers.${providerId}`);
      if (providerInput.modelOverrides !== undefined) {
        Object.assign(
          modelOverrides,
          parsePiModelOverrides(providerId, providerInput.modelOverrides, `providers.${providerId}.modelOverrides`),
        );
      }
      if (providerInput.models !== undefined || providerInput.modelOverrides === undefined) {
        providers[providerId] = parseProvider(providerId, provider, "pi");
      }
    }
    let model: ModelSelectionConfig | undefined;
    let defaultThinkingLevel: ModelThinkingLevel | undefined;
    const settingsPath = path.join(piDir, "settings.json");
    try {
      const settings = object(await readJson(settingsPath, "pi settings"), "pi settings");
      if (typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string") {
        model = { provider: settings.defaultProvider, id: settings.defaultModel };
      }
      if (settings.defaultThinkingLevel !== undefined) {
        defaultThinkingLevel = thinkingLevel(settings.defaultThinkingLevel, "settings.defaultThinkingLevel");
      }
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    return {
      path: modelsPath,
      source: "pi",
      agentDiagnostics: [],
      config: {
        ...(model ? { model } : {}),
        ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
        agents: {},
        modelOverrides,
        providers,
      },
    };
  } catch (error) {
    throw new Error(`Invalid pi model config ${modelsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadThreadConfig(configuredPath?: string): Promise<LoadedThreadConfig | undefined> {
  const configPath = configuredPath ? path.resolve(configuredPath) : getDefaultThreadConfigPath();
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && configuredPath === undefined) {
      return loadPiThreadConfig();
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
    return { path: configPath, source: "thread", ...parseConfig(parsed) };
  } catch (error) {
    throw new Error(`Invalid Thread config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
