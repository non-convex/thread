import {
  type Api, type AuthInteraction, type CredentialStore, type Model, type Models, type MutableModels,
  createProvider, InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { resolveConfigHeaders, resolveConfigValue } from "../config/config-value.js";
import type { CustomProviderConfig, ModelOverrideConfig } from "../config/model-config.js";
import { PiModelClient, type ModelClient } from "./model-client.js";

export interface ModelDescriptor {
  providerId: string;
  modelId: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
  acceptsImages?: boolean;
}
export interface ModelCatalog {
  list(providerId?: string): ModelDescriptor[];
  listAll?(providerId?: string): ModelDescriptor[];
  createClient(providerId: string, modelId: string): ModelClient;
}
export interface ModelAuthProviderStatus {
  providerId: string;
  name: string;
  authenticated: boolean;
  credentialType?: "api_key" | "oauth";
}
export interface ModelCatalogOptions {
  credentials?: CredentialStore;
  enabledProviderIds?: readonly string[];
  modelOverrides?: Readonly<Record<string, ModelOverrideConfig>>;
}

const modelKey = (provider: string, id: string) => `${provider}\0${id}`;
const overrideKey = (provider: string, id: string) => `${provider}/${id}`;
const apis = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
};

/** Model discovery, provider registration and subscription authentication. */
export class PiModelCatalog implements ModelCatalog {
  private readonly configuredModelKeys: ReadonlySet<string> | undefined;
  private readonly enabledProviderIds: ReadonlySet<string>;
  private readonly modelOverrides: ReadonlyMap<string, ModelOverrideConfig>;

  constructor(
    private readonly models: Models,
    configuredModels?: readonly { providerId: string; modelId: string }[],
    private readonly credentials: CredentialStore = new InMemoryCredentialStore(),
    enabledProviderIds: readonly string[] = [],
    modelOverrides: Readonly<Record<string, ModelOverrideConfig>> = {},
  ) {
    this.configuredModelKeys = configuredModels && new Set(configuredModels.map((model) => modelKey(model.providerId, model.modelId)));
    this.enabledProviderIds = new Set(enabledProviderIds);
    this.modelOverrides = new Map(Object.entries(modelOverrides).map(([key, override]) => [key, { ...override }]));
    const available = new Map(models.getModels().map((model) => [overrideKey(model.provider, model.id), model]));
    for (const [key, override] of this.modelOverrides) {
      const model = available.get(key);
      if (!model) throw new Error(`Model override targets an unknown model: ${key}`);
      if (override.contextWindow < model.maxTokens) throw new Error(`Model override contextWindow cannot be smaller than maxTokens for ${key}`);
    }
  }

  list(providerId?: string): ModelDescriptor[] {
    return this.describe(this.models.getModels(providerId).filter((model) =>
      !this.configuredModelKeys || this.enabledProviderIds.has(model.provider) || this.configuredModelKeys.has(modelKey(model.provider, model.id))
    ));
  }
  listAll(providerId?: string): ModelDescriptor[] { return this.describe(this.models.getModels(providerId)); }

  private describe(models: readonly Model<Api>[]): ModelDescriptor[] {
    return models.map((model) => ({
      providerId: model.provider, modelId: model.id, name: model.name,
      contextWindow: this.modelOverrides.get(overrideKey(model.provider, model.id))?.contextWindow ?? model.contextWindow,
      maxOutputTokens: model.maxTokens, reasoning: model.reasoning, acceptsImages: model.input.includes("image"),
    })).sort((a, b) => a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId));
  }

  createClient(providerId: string, modelId: string): PiModelClient {
    const model = this.models.getModel(providerId, modelId);
    if (!model) {
      const examples = this.models.getModels(providerId).slice(0, 8).map((candidate) => candidate.id).join(", ");
      throw new Error(`Unknown model ${providerId}/${modelId}.${examples ? ` Available examples: ${examples}` : " Unknown provider."}`);
    }
    return new PiModelClient(this.models, model, undefined, undefined, this.modelOverrides.get(overrideKey(providerId, modelId)));
  }

  private requireOAuth(providerId: string): void {
    const provider = this.models.getProvider(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    if (!provider.auth.oauth) throw new Error(`Provider ${providerId} does not support subscription login`);
  }
  async login(providerId: string, interaction: AuthInteraction): Promise<void> {
    this.requireOAuth(providerId);
    await this.models.login(providerId, "oauth", interaction);
  }
  async logout(providerId: string, signal?: AbortSignal): Promise<void> {
    this.requireOAuth(providerId);
    await this.models.logout(providerId, signal ? { signal } : undefined);
  }
  async authStatus(signal?: AbortSignal): Promise<ModelAuthProviderStatus[]> {
    const stored = new Map((await this.credentials.list(signal ? { signal } : undefined)).map((item) => [item.providerId, item.type]));
    return this.models.getProviders().filter((provider) => provider.auth.oauth !== undefined).map((provider) => {
      const credentialType = stored.get(provider.id);
      return { providerId: provider.id, name: provider.name, authenticated: credentialType === "oauth",
        ...(credentialType ? { credentialType } : {}) };
    }).sort((a, b) => a.providerId.localeCompare(b.providerId));
  }
}

function registerCustomProvider(models: MutableModels, providerId: string, config: CustomProviderConfig): void {
  if (!config.apiKeyEnv && !config.apiKey) throw new Error(`Provider ${providerId} has no API key configuration`);
  const providerModels: Model<Api>[] = config.models.map((model) => {
    const { id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap, samplingParams } = model;
    const compat = config.compat || model.compat ? { ...config.compat, ...model.compat } : undefined;
    return { id, name, api: config.api, provider: providerId, baseUrl: config.baseUrl, reasoning, input, contextWindow, maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}), ...(samplingParams ? { samplingParams } : {}),
      ...(compat ? { compat: compat as NonNullable<Model<Api>["compat"]> } : {}),
    };
  });
  models.setProvider(createProvider({
    id: providerId, name: config.name, baseUrl: config.baseUrl, models: providerModels, api: apis[config.api](),
    auth: { apiKey: {
      name: `${config.name} API key`,
      resolve: async ({ ctx, credential, signal }) => {
        signal.throwIfAborted();
        const key = credential?.key ?? (config.apiKeyEnv
          ? await ctx.env(config.apiKeyEnv) : await resolveConfigValue(config.apiKey!, (name) => ctx.env(name)));
        const headers = await resolveConfigHeaders(config.headers, (name) => ctx.env(name));
        signal.throwIfAborted();
        return key ? { auth: { apiKey: key, ...(headers ? { headers } : {}) },
          source: credential?.key ? "stored credential" : config.apiKeyEnv ?? "pi models.json" } : undefined;
      },
    } },
  }));
}

export function createBuiltinModelClient(providerId: string, modelId: string): PiModelClient {
  const credentials = new InMemoryCredentialStore();
  registerBunOAuthFlows();
  return new PiModelCatalog(builtinModels({ credentials }), undefined, credentials).createClient(providerId, modelId);
}

export function createConfiguredModelClient(providerId: string, modelId: string, providers: Record<string, CustomProviderConfig>): PiModelClient {
  return createConfiguredModelCatalog(providers).createClient(providerId, modelId);
}

export function createConfiguredModelCatalog(providers: Record<string, CustomProviderConfig>, options: ModelCatalogOptions = {}): PiModelCatalog {
  const credentials = options.credentials ?? new InMemoryCredentialStore();
  // Standalone Bun cannot discover pi-ai's private lazy OAuth modules at runtime.
  registerBunOAuthFlows();
  const models = builtinModels({ credentials });
  const configuredModels = Object.entries(providers).flatMap(([providerId, config]) => {
    registerCustomProvider(models, providerId, config);
    return config.models.map((model) => ({ providerId, modelId: model.id }));
  });
  return new PiModelCatalog(models, configuredModels, credentials, options.enabledProviderIds, options.modelOverrides);
}
