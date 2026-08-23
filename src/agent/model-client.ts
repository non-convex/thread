import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type Models,
  type MutableModels,
  createProvider,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { resolveConfigHeaders, resolveConfigValue } from "../config/config-value.js";
import type { CustomProviderConfig, SupportedCustomApi } from "../config/model-config.js";

export interface ModelRequestOptions {
  signal: AbortSignal;
  maxTokens?: number;
  reasoning?: ThinkingLevel;
  sessionId?: string;
  onTextDelta?: (delta: string) => void;
}

export interface ModelClient {
  readonly modelId: string;
  readonly providerId: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage>;
  completeText(systemPrompt: string, prompt: string, options: ModelRequestOptions): Promise<string>;
}

export interface ModelDescriptor {
  providerId: string;
  modelId: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  reasoning: boolean;
}

export interface ModelCatalog {
  list(providerId?: string): ModelDescriptor[];
  createClient(providerId: string, modelId: string): ModelClient;
}

export class PiModelClient implements ModelClient {
  readonly modelId: string;
  readonly providerId: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;

  constructor(
    private readonly models: Models,
    private readonly model: Model<Api>,
  ) {
    this.modelId = model.id;
    this.providerId = model.provider;
    this.contextWindow = model.contextWindow;
    this.maxOutputTokens = model.maxTokens;
  }

  async stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage> {
    const stream = this.models.streamSimple(this.model, context, {
      signal: options.signal,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
      sessionId: options.sessionId ?? `thread:${this.providerId}:${this.modelId}`,
    });
    if (options.onTextDelta) {
      for await (const event of stream) {
        if (event.type === "text_delta") options.onTextDelta(event.delta);
      }
    }
    return stream.result();
  }

  async completeText(systemPrompt: string, prompt: string, options: ModelRequestOptions): Promise<string> {
    const message = await this.models.completeSimple(
      this.model,
      {
        systemPrompt,
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      },
      {
        signal: options.signal,
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
      },
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? `Semantic model stopped with ${message.stopReason}`);
    }
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
  }
}

export class PiModelCatalog implements ModelCatalog {
  constructor(private readonly models: Models) {}

  list(providerId?: string): ModelDescriptor[] {
    return this.models
      .getModels(providerId)
      .map((model) => ({
        providerId: model.provider,
        modelId: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        reasoning: model.reasoning,
      }))
      .sort((left, right) =>
        left.providerId.localeCompare(right.providerId) || left.modelId.localeCompare(right.modelId),
      );
  }

  createClient(providerId: string, modelId: string): PiModelClient {
    return selectModelClient(this.models, providerId, modelId);
  }
}

export function createBuiltinModelClient(providerId: string, modelId: string): PiModelClient {
  return new PiModelCatalog(builtinModels()).createClient(providerId, modelId);
}

function apiFor(api: SupportedCustomApi) {
  if (api === "openai-completions") return openAICompletionsApi();
  if (api === "openai-responses") return openAIResponsesApi();
  return anthropicMessagesApi();
}

function registerCustomProvider(models: MutableModels, providerId: string, config: CustomProviderConfig): void {
  if (!config.apiKeyEnv && !config.apiKey) throw new Error(`Provider ${providerId} has no API key configuration`);
  const providerModels: Model<Api>[] = config.models.map((model) => {
    const compat =
      config.compat || model.compat ? { ...(config.compat ?? {}), ...(model.compat ?? {}) } : undefined;
    return {
      id: model.id,
      name: model.name,
      api: config.api,
      provider: providerId,
      baseUrl: config.baseUrl,
      reasoning: model.reasoning,
      input: model.input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      ...(model.samplingParams ? { samplingParams: model.samplingParams } : {}),
      ...(compat ? { compat: compat as NonNullable<Model<Api>["compat"]> } : {}),
    };
  });
  models.setProvider(
    createProvider({
      id: providerId,
      name: config.name,
      baseUrl: config.baseUrl,
      auth: {
        apiKey: {
          name: `${config.name} API key`,
          resolve: async ({ ctx, credential, signal }) => {
            signal.throwIfAborted();
            const key =
              credential?.key ??
              (config.apiKeyEnv
                ? await ctx.env(config.apiKeyEnv)
                : await resolveConfigValue(config.apiKey!, (name) => ctx.env(name)));
            const headers = await resolveConfigHeaders(config.headers, (name) => ctx.env(name));
            signal.throwIfAborted();
            if (!key) return undefined;
            return {
              auth: { apiKey: key, ...(headers ? { headers } : {}) },
              source: credential?.key ? "stored credential" : config.apiKeyEnv ?? "pi models.json",
            };
          },
        },
      },
      models: providerModels,
      api: apiFor(config.api),
    }),
  );
}

export function createConfiguredModelClient(
  providerId: string,
  modelId: string,
  providers: Record<string, CustomProviderConfig>,
): PiModelClient {
  return createConfiguredModelCatalog(providers).createClient(providerId, modelId);
}

export function createConfiguredModelCatalog(
  providers: Record<string, CustomProviderConfig>,
): PiModelCatalog {
  const models = builtinModels();
  for (const [customProviderId, config] of Object.entries(providers)) {
    registerCustomProvider(models, customProviderId, config);
  }
  return new PiModelCatalog(models);
}

function selectModelClient(models: Models, providerId: string, modelId: string): PiModelClient {
  const model = models.getModel(providerId, modelId);
  if (!model) {
    const examples = models
      .getModels(providerId)
      .slice(0, 8)
      .map((candidate) => candidate.id)
      .join(", ");
    throw new Error(
      `Unknown model ${providerId}/${modelId}.${examples ? ` Available examples: ${examples}` : " Unknown provider."}`,
    );
  }
  return new PiModelClient(models, model);
}
