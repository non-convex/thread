import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { CacheRetention, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

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

/** @deprecated Use ImplementationWorkerConfig. */
export type AgentProfileConfig = ImplementationWorkerConfig;

export interface DreamerConfig {
  model: ModelSelectionConfig;
  thinkingLevel: ModelThinkingLevel;
}

export interface ThreadConfig {
  model?: ModelSelectionConfig;
  agents: {
    "implementation-worker"?: ImplementationWorkerConfig;
    dreamer?: DreamerConfig;
  };
  defaultThinkingLevel?: ModelThinkingLevel;
  /**
   * Prompt-cache lifetime for every model request. Omitted means the provider
   * default (Anthropic 5-minute ephemeral). `long` trades a higher cache-write
   * price for a 1h/24h window and only pays off when gaps between turns
   * routinely exceed five minutes.
   */
  cacheRetention?: CacheRetention;
  modelOverrides?: Record<string, ModelOverrideConfig>;
  providers: Record<string, CustomProviderConfig>;
}

export interface LoadedThreadConfig {
  path: string;
  source: "thread" | "pi";
  config: ThreadConfig;
  agentDiagnostics: string[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${label} must be a positive integer`);
  return value as number;
}

function optionalStringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const input = object(value, label);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(input)) result[key] = string(item, `${label}.${key}`);
  return result;
}

function optionalUnknownRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  return value === undefined ? undefined : object(value, label);
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function thinkingLevel(value: unknown, label: string): ModelThinkingLevel {
  if (typeof value !== "string" || !THINKING_LEVELS.includes(value as ModelThinkingLevel)) {
    throw new Error(`${label} must be off, minimal, low, medium, high, xhigh, or max`);
  }
  return value as ModelThinkingLevel;
}

function cacheRetention(value: unknown, label: string): CacheRetention {
  if (value !== "none" && value !== "short" && value !== "long") {
    throw new Error(`${label} must be none, short, or long`);
  }
  return value;
}

function optionalThinkingLevelMap(value: unknown, label: string): ThinkingLevelMap | undefined {
  if (value === undefined) return undefined;
  const input = object(value, label);
  const result: ThinkingLevelMap = {};
  for (const [key, mapped] of Object.entries(input)) {
    const level = thinkingLevel(key, `${label} key`);
    if (mapped !== null && typeof mapped !== "string") {
      throw new Error(`${label}.${key} must be a string or null`);
    }
    result[level] = mapped;
  }
  return result;
}

function parseModel(value: unknown, label: string): CustomModelConfig {
  const input = object(value, label);
  const contextWindow = positiveInteger(input.contextWindow, `${label}.contextWindow`);
  const maxTokens = positiveInteger(input.maxTokens, `${label}.maxTokens`);
  if (maxTokens > contextWindow) throw new Error(`${label}.maxTokens cannot exceed contextWindow`);
  let modelInput: ("text" | "image")[] = ["text"];
  if (input.input !== undefined) {
    if (!Array.isArray(input.input) || input.input.length === 0) throw new Error(`${label}.input must be a non-empty array`);
    modelInput = input.input.map((item, index) => {
      if (item !== "text" && item !== "image") throw new Error(`${label}.input[${index}] must be text or image`);
      return item;
    });
  }
  if (input.reasoning !== undefined && typeof input.reasoning !== "boolean") {
    throw new Error(`${label}.reasoning must be a boolean`);
  }
  const id = string(input.id, `${label}.id`);
  const thinkingLevelMap = optionalThinkingLevelMap(input.thinkingLevelMap, `${label}.thinkingLevelMap`);
  const samplingParams = optionalUnknownRecord(input.samplingParams, `${label}.samplingParams`);
  const compat = optionalUnknownRecord(input.compat, `${label}.compat`);
  return {
    id,
    name: input.name === undefined ? id : string(input.name, `${label}.name`),
    reasoning: input.reasoning ?? false,
    input: modelInput,
    contextWindow,
    maxTokens,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(samplingParams ? { samplingParams } : {}),
    ...(compat ? { compat } : {}),
  };
}

function parseModelOverride(value: unknown, label: string): ModelOverrideConfig {
  const input = object(value, label);
  return { contextWindow: positiveInteger(input.contextWindow, `${label}.contextWindow`) };
}

function parseModelOverrides(value: unknown, label: string): Record<string, ModelOverrideConfig> {
  const overrides: Record<string, ModelOverrideConfig> = {};
  for (const [key, override] of Object.entries(object(value, label))) {
    const separator = key.indexOf("/");
    if (separator <= 0 || separator === key.length - 1) {
      throw new Error(`${label} keys must use <provider>/<model-id>`);
    }
    overrides[key] = parseModelOverride(override, `${label}.${key}`);
  }
  return overrides;
}

function parsePiModelOverrides(
  providerId: string,
  value: unknown,
  label: string,
): Record<string, ModelOverrideConfig> {
  const overrides: Record<string, ModelOverrideConfig> = {};
  for (const [modelId, override] of Object.entries(object(value, label))) {
    if (!modelId.trim()) throw new Error(`${label} model id cannot be empty`);
    const input = object(override, `${label}.${modelId}`);
    if (input.contextWindow === undefined) continue;
    overrides[`${providerId}/${modelId}`] = parseModelOverride(input, `${label}.${modelId}`);
  }
  return overrides;
}

function parseProvider(providerId: string, value: unknown): CustomProviderConfig {
  const label = `providers.${providerId}`;
  const input = object(value, label);
  const api = string(input.api, `${label}.api`);
  if (api !== "openai-completions" && api !== "openai-responses" && api !== "anthropic-messages") {
    throw new Error(`${label}.api must be openai-completions, openai-responses, or anthropic-messages`);
  }
  const baseUrl = string(input.baseUrl, `${label}.baseUrl`);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error(`${label}.baseUrl must be an absolute URL`);
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error(`${label}.baseUrl must use http or https`);
  }
  const apiKeyEnv = input.apiKeyEnv === undefined ? undefined : string(input.apiKeyEnv, `${label}.apiKeyEnv`);
  const apiKey = input.apiKey === undefined ? undefined : string(input.apiKey, `${label}.apiKey`);
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error(`${label}.apiKeyEnv is not a valid environment name`);
  }
  if (apiKeyEnv && apiKey) throw new Error(`${label} must use either apiKeyEnv or apiKey, not both`);
  if (!apiKeyEnv && !apiKey) throw new Error(`${label} must configure apiKeyEnv or apiKey`);
  if (!Array.isArray(input.models) || input.models.length === 0) {
    throw new Error(`${label}.models must be a non-empty array`);
  }
  const models = input.models.map((model, index) => parseModel(model, `${label}.models[${index}]`));
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error(`${label}.models contains duplicate ids`);
  }
  const headers = optionalStringRecord(input.headers, `${label}.headers`);
  const compat = optionalUnknownRecord(input.compat, `${label}.compat`);
  return {
    name: input.name === undefined ? providerId : string(input.name, `${label}.name`),
    api,
    baseUrl,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(headers ? { headers } : {}),
    ...(compat ? { compat } : {}),
    models,
  };
}

function parsePiProvider(providerId: string, value: unknown): CustomProviderConfig {
  const label = `providers.${providerId}`;
  const input = object(value, label);
  const api = string(input.api, `${label}.api`);
  if (api !== "openai-completions" && api !== "openai-responses" && api !== "anthropic-messages") {
    throw new Error(`${label}.api is not supported by thread: ${api}`);
  }
  const baseUrl = string(input.baseUrl, `${label}.baseUrl`);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error(`${label}.baseUrl must be an absolute URL`);
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error(`${label}.baseUrl must use http or https`);
  }
  const apiKey = string(input.apiKey, `${label}.apiKey`);
  if (!Array.isArray(input.models) || input.models.length === 0) {
    throw new Error(`${label}.models must be a non-empty array`);
  }
  const models = input.models.map((model, index) => parseModel(model, `${label}.models[${index}]`));
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error(`${label}.models contains duplicate ids`);
  }
  const headers = optionalStringRecord(input.headers, `${label}.headers`);
  const compat = optionalUnknownRecord(input.compat, `${label}.compat`);
  return {
    name: input.name === undefined ? providerId : string(input.name, `${label}.name`),
    api,
    baseUrl,
    apiKey,
    ...(headers ? { headers } : {}),
    ...(compat ? { compat } : {}),
    models,
  };
}

function parseImplementationWorker(value: unknown, label: string): ImplementationWorkerConfig {
  const input = object(value, label);
  const selected = object(input.model, `${label}.model`);
  return {
    model: {
      provider: string(selected.provider, `${label}.model.provider`),
      id: string(selected.id, `${label}.model.id`),
    },
    thinkingLevel: input.thinkingLevel === undefined ? "xhigh" : thinkingLevel(input.thinkingLevel, `${label}.thinkingLevel`),
    maxConcurrent: input.maxConcurrent === undefined ? 2 : positiveInteger(input.maxConcurrent, `${label}.maxConcurrent`),
    maxSteps: input.maxSteps === undefined ? 100 : positiveInteger(input.maxSteps, `${label}.maxSteps`),
    maxRuntimeMinutes: input.maxRuntimeMinutes === undefined ? 60 : positiveInteger(input.maxRuntimeMinutes, `${label}.maxRuntimeMinutes`),
    maxRevisions: input.maxRevisions === undefined ? 2 : positiveInteger(input.maxRevisions, `${label}.maxRevisions`),
  };
}

function parseDreamer(value: unknown, label: string): DreamerConfig {
  const input = object(value, label);
  const selected = object(input.model, `${label}.model`);
  return {
    model: {
      provider: string(selected.provider, `${label}.model.provider`),
      id: string(selected.id, `${label}.model.id`),
    },
    thinkingLevel: input.thinkingLevel === undefined
      ? "low"
      : thinkingLevel(input.thinkingLevel, `${label}.thinkingLevel`),
  };
}

function parseConfig(value: unknown): { config: ThreadConfig; agentDiagnostics: string[] } {
  const input = object(value, "config");
  let model: ModelSelectionConfig | undefined;
  if (input.model !== undefined) {
    const selected = object(input.model, "model");
    model = { provider: string(selected.provider, "model.provider"), id: string(selected.id, "model.id") };
  }
  const modelOverrides = input.modelOverrides === undefined
    ? {}
    : parseModelOverrides(input.modelOverrides, "modelOverrides");
  const providers: Record<string, CustomProviderConfig> = {};
  if (input.providers !== undefined) {
    for (const [providerId, provider] of Object.entries(object(input.providers, "providers"))) {
      if (!providerId.trim()) throw new Error("provider id cannot be empty");
      providers[providerId] = parseProvider(providerId, provider);
    }
  }
  const agents: ThreadConfig["agents"] = {};
  const agentDiagnostics: string[] = [];
  if (input.agents !== undefined) {
    try {
      const configuredAgents = object(input.agents, "agents");
      for (const key of Object.keys(configuredAgents)) {
        if (key !== "implementation-worker" && key !== "dreamer") {
          agentDiagnostics.push(`Unknown agent profile: ${key}`);
        }
      }
      if (configuredAgents["implementation-worker"] !== undefined) {
        agents["implementation-worker"] = parseImplementationWorker(
          configuredAgents["implementation-worker"],
          "agents.implementation-worker",
        );
      }
      if (configuredAgents.dreamer !== undefined) {
        agents.dreamer = parseDreamer(configuredAgents.dreamer, "agents.dreamer");
      }
    } catch (error) {
      agentDiagnostics.push(error instanceof Error ? error.message : String(error));
    }
  }
  const defaultThinkingLevel = input.defaultThinkingLevel === undefined
    ? undefined
    : thinkingLevel(input.defaultThinkingLevel, "defaultThinkingLevel");
  const retention = input.cacheRetention === undefined
    ? undefined
    : cacheRetention(input.cacheRetention, "cacheRetention");
  return {
    config: {
      ...(model ? { model } : {}),
      ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
      ...(retention ? { cacheRetention: retention } : {}),
      agents,
      modelOverrides,
      providers,
    },
    agentDiagnostics,
  };
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
      if (providerInput.models !== undefined) providers[providerId] = parsePiProvider(providerId, provider);
      else if (providerInput.modelOverrides === undefined) providers[providerId] = parsePiProvider(providerId, provider);
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
