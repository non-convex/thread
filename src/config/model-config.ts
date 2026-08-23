import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_THREAD_HOME_NAME = ".thread";
export const DEFAULT_MODEL_CONFIG_FILE = "config.json";

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

export interface ThreadModelConfig {
  model?: ModelSelectionConfig;
  providers: Record<string, CustomProviderConfig>;
}

export interface LoadedModelConfig {
  path: string;
  source: "thread" | "pi";
  config: ThreadModelConfig;
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
  const samplingParams = optionalUnknownRecord(input.samplingParams, `${label}.samplingParams`);
  const compat = optionalUnknownRecord(input.compat, `${label}.compat`);
  return {
    id,
    name: input.name === undefined ? id : string(input.name, `${label}.name`),
    reasoning: input.reasoning ?? false,
    input: modelInput,
    contextWindow,
    maxTokens,
    ...(samplingParams ? { samplingParams } : {}),
    ...(compat ? { compat } : {}),
  };
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
  const apiKeyEnv = string(input.apiKeyEnv, `${label}.apiKeyEnv`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error(`${label}.apiKeyEnv is not a valid environment name`);
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
    apiKeyEnv,
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

function parseConfig(value: unknown): ThreadModelConfig {
  const input = object(value, "config");
  let model: ModelSelectionConfig | undefined;
  if (input.model !== undefined) {
    const selected = object(input.model, "model");
    model = { provider: string(selected.provider, "model.provider"), id: string(selected.id, "model.id") };
  }
  const providers: Record<string, CustomProviderConfig> = {};
  if (input.providers !== undefined) {
    for (const [providerId, provider] of Object.entries(object(input.providers, "providers"))) {
      if (!providerId.trim()) throw new Error("provider id cannot be empty");
      providers[providerId] = parseProvider(providerId, provider);
    }
  }
  return { ...(model ? { model } : {}), providers };
}

export function getThreadHome(): string {
  const configured = process.env.THREAD_HOME;
  return configured ? path.resolve(configured) : path.join(homedir(), DEFAULT_THREAD_HOME_NAME);
}

export function getDefaultModelConfigPath(): string {
  return path.join(getThreadHome(), DEFAULT_MODEL_CONFIG_FILE);
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

async function loadPiModelConfig(): Promise<LoadedModelConfig | undefined> {
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
    for (const [providerId, provider] of Object.entries(object(input.providers, "providers"))) {
      providers[providerId] = parsePiProvider(providerId, provider);
    }
    let model: ModelSelectionConfig | undefined;
    const settingsPath = path.join(piDir, "settings.json");
    try {
      const settings = object(await readJson(settingsPath, "pi settings"), "pi settings");
      if (typeof settings.defaultProvider === "string" && typeof settings.defaultModel === "string") {
        model = { provider: settings.defaultProvider, id: settings.defaultModel };
      }
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    return { path: modelsPath, source: "pi", config: { ...(model ? { model } : {}), providers } };
  } catch (error) {
    throw new Error(`Invalid pi model config ${modelsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadModelConfig(configuredPath?: string): Promise<LoadedModelConfig | undefined> {
  const configPath = configuredPath ? path.resolve(configuredPath) : getDefaultModelConfigPath();
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && configuredPath === undefined) {
      return loadPiModelConfig();
    }
    throw new Error(`Cannot read model config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Cannot parse model config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return { path: configPath, source: "thread", config: parseConfig(parsed) };
  } catch (error) {
    throw new Error(`Invalid model config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
