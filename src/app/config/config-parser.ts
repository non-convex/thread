import type { CacheRetention, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { AttributionConfig, DreamerConfig, WorkerConfig, ThreadConfig } from "./thread-config.js";
import type { CustomModelConfig, CustomProviderConfig, ModelOverrideConfig, ModelSelectionConfig } from "../../core/config/model-config.js";

export function object(value: unknown, label: string): Record<string, unknown> {
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

export function thinkingLevel(value: unknown, label: string): ModelThinkingLevel {
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

export function parsePiModelOverrides(
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

export function parseProvider(providerId: string, value: unknown, source: "thread" | "pi" = "thread"): CustomProviderConfig {
  const label = `providers.${providerId}`;
  const input = object(value, label);
  const api = string(input.api, `${label}.api`);
  if (api !== "openai-completions" && api !== "openai-responses" && api !== "anthropic-messages") {
    throw new Error(source === "pi" ? `${label}.api is not supported by thread: ${api}`
      : `${label}.api must be openai-completions, openai-responses, or anthropic-messages`);
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
  const apiKeyEnv = source === "pi" || input.apiKeyEnv === undefined ? undefined : string(input.apiKeyEnv, `${label}.apiKeyEnv`);
  const apiKey = source === "thread" && input.apiKey === undefined ? undefined : string(input.apiKey, `${label}.apiKey`);
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

function parseWorker(value: unknown, label: string): WorkerConfig {
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
      ? "high"
      : thinkingLevel(input.thinkingLevel, `${label}.thinkingLevel`),
  };
}

function parseAttribution(value: unknown): AttributionConfig {
  const input = object(value, "attribution");
  if (typeof input.commit !== "string") throw new Error("attribution.commit must be a string");
  return { commit: input.commit };
}

export function parseConfig(value: unknown): { config: ThreadConfig; agentDiagnostics: string[] } {
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
        if (key !== "worker" && key !== "dreamer") {
          agentDiagnostics.push(`Unknown agent profile: ${key}`);
        }
      }
      if (configuredAgents.worker !== undefined) agents.worker = parseWorker(configuredAgents.worker, "agents.worker");
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
  const attribution = input.attribution === undefined ? undefined : parseAttribution(input.attribution);
  let search: ThreadConfig["search"];
  if (input.search !== undefined) {
    const value = object(input.search, "search");
    if (value.semantic !== undefined && typeof value.semantic !== "boolean") throw new Error("search.semantic must be a boolean");
    search = { semantic: value.semantic === undefined ? true : value.semantic as boolean };
  }
  return {
    config: {
      ...(model ? { model } : {}),
      ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
      ...(retention ? { cacheRetention: retention } : {}),
      ...(attribution ? { attribution } : {}),
      ...(search ? { search } : {}),
      agents,
      modelOverrides,
      providers,
    },
    agentDiagnostics,
  };
}
