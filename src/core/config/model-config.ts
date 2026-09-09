import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

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
