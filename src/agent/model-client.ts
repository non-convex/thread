import {
  type Api,
  type AssistantMessage,
  type CacheRetention,
  type Context,
  type Model,
  type ModelThinkingLevel,
  type Models,
  type MutableModels,
  createProvider,
  getSupportedThinkingLevels,
  retryAssistantCall,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { resolveConfigHeaders, resolveConfigValue } from "../config/config-value.js";
import type { CustomProviderConfig, SupportedCustomApi } from "../config/model-config.js";

/** Transient provider errors (408/409/429/5xx and server-requested retries). */
export const DEFAULT_MODEL_MAX_RETRIES = 10;
/** Initial backoff for assistant-level retries; doubles each attempt. */
export const DEFAULT_MODEL_RETRY_BASE_DELAY_MS = 500;

export interface ModelRetryCallbacks {
  onRetryScheduled?: (attempt: number, maxAttempts: number, delayMs: number, errorMessage: string) => void | Promise<void>;
  onRetryAttemptStart?: (attempt: number, maxAttempts: number) => void | Promise<void>;
  onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

export interface ModelRequestOptions {
  signal: AbortSignal;
  maxTokens?: number;
  reasoning?: ThinkingLevel;
  /**
   * Prompt-cache partition key. Every request that shares a prefix must send the
   * same value: providers that key their cache on it (OpenAI `prompt_cache_key`,
   * session-affinity headers) route a different key to a different shard, so a
   * mismatch silently discards an otherwise reusable prefix. Defaults to
   * {@link PiModelClient.cacheKey}; callers normally leave it unset.
   */
  sessionId?: string;
  /**
   * Prompt-cache lifetime. `short` is the provider default (Anthropic 5-minute
   * ephemeral, no OpenAI retention hint); `long` asks for 1h/24h and `none`
   * disables caching. Long retention bills Anthropic cache writes at 2x the base
   * input rate instead of 1.25x, so it only pays off when idle gaps between turns
   * routinely exceed five minutes. Defaults to {@link ModelClient.cacheRetention}.
   */
  cacheRetention?: CacheRetention;
  /** Assistant-level transient retries; defaults to {@link DEFAULT_MODEL_MAX_RETRIES}. */
  maxRetries?: number;
  /** Backoff before the first retry; defaults to {@link DEFAULT_MODEL_RETRY_BASE_DELAY_MS}. */
  retryBaseDelayMs?: number;
  onRetryScheduled?: ModelRetryCallbacks["onRetryScheduled"];
  onRetryAttemptStart?: ModelRetryCallbacks["onRetryAttemptStart"];
  onRetryFinished?: ModelRetryCallbacks["onRetryFinished"];
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
}

export interface ModelClient {
  readonly modelId: string;
  readonly providerId: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning?: boolean;
  readonly supportedThinkingLevels?: readonly ModelThinkingLevel[];
  /**
   * Prompt-cache partition key shared by every request this client makes, so the
   * live turn, its summary forks and the semantic helpers all land in one shard.
   * Set through {@link PiModelClient.withCacheKey}.
   */
  readonly cacheKey?: string;
  /** Default prompt-cache lifetime for this client's requests. */
  readonly cacheRetention?: CacheRetention | undefined;
  stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage>;
  completeText(systemPrompt: string, prompt: string, options: ModelRequestOptions): Promise<string>;
  /**
   * Fork the live conversation: reuse its exact prefix (system prompt plus
   * messages) and append one instruction as the newest user message. The reply
   * is returned to the caller instead of entering the agent loop, so the prefix
   * stays byte-identical and keeps hitting the provider's prompt cache.
   */
  forkComplete(context: Context, instruction: string, options: ModelRequestOptions): Promise<string>;
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
  listAll?(providerId?: string): ModelDescriptor[];
  createClient(providerId: string, modelId: string): ModelClient;
}

export class PiModelClient implements ModelClient {
  readonly modelId: string;
  readonly providerId: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: boolean;
  readonly supportedThinkingLevels: readonly ModelThinkingLevel[];
  readonly cacheKey: string;
  readonly cacheRetention: CacheRetention | undefined;

  constructor(
    private readonly models: Models,
    private readonly model: Model<Api>,
    cacheKey?: string,
    cacheRetention?: CacheRetention,
  ) {
    this.modelId = model.id;
    this.providerId = model.provider;
    this.contextWindow = model.contextWindow;
    this.maxOutputTokens = model.maxTokens;
    this.reasoning = model.reasoning;
    this.supportedThinkingLevels = getSupportedThinkingLevels(model);
    this.cacheKey = cacheKey ?? `thread:${this.providerId}:${this.modelId}`;
    this.cacheRetention = cacheRetention;
  }

  /**
   * Same model, different prompt-cache partition. Used to bind a client to one
   * Session Tree so its turns and summary forks share a shard
   * instead of colliding with another tree open on the same model.
   */
  withCacheKey(cacheKey: string): PiModelClient {
    return new PiModelClient(this.models, this.model, cacheKey, this.cacheRetention);
  }

  /** Same model and partition, different cache lifetime. */
  withCacheRetention(cacheRetention: CacheRetention | undefined): PiModelClient {
    return new PiModelClient(this.models, this.model, this.cacheKey, cacheRetention);
  }

  /**
   * Per-request retention wins over the client default; leaving both unset lets
   * pi-ai apply its own resolution (which also honours `PI_CACHE_RETENTION`).
   */
  private resolveRetention(options: ModelRequestOptions): CacheRetention | undefined {
    return options.cacheRetention ?? this.cacheRetention;
  }

  async stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage> {
    const maxRetries = options.maxRetries ?? DEFAULT_MODEL_MAX_RETRIES;
    const baseDelayMs = options.retryBaseDelayMs ?? DEFAULT_MODEL_RETRY_BASE_DELAY_MS;
    const cacheRetention = this.resolveRetention(options);
    let scheduledAttempt = 0;
    return retryAssistantCall(
      async () => {
        const stream = this.models.streamSimple(this.model, context, {
          signal: options.signal,
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
          // Retries are handled above so the TUI can observe every attempt.
          maxRetries: 0,
          sessionId: options.sessionId ?? this.cacheKey,
          ...(cacheRetention === undefined ? {} : { cacheRetention }),
        });
        for await (const event of stream) {
          if (event.type === "text_delta") options.onTextDelta?.(event.delta);
          if (event.type === "thinking_delta") options.onThinkingDelta?.(event.delta);
        }
        return stream.result();
      },
      { enabled: true, maxRetries, baseDelayMs },
      options.signal,
      {
        onRetryScheduled: async (attempt, maxAttempts, delayMs, errorMessage) => {
          scheduledAttempt = attempt;
          await options.onRetryScheduled?.(attempt, maxAttempts, delayMs, errorMessage);
        },
        onRetryAttemptStart: async () => {
          await options.onRetryAttemptStart?.(scheduledAttempt, maxRetries);
        },
        onRetryFinished: async (success, attempt, finalError) => {
          await options.onRetryFinished?.(success, attempt, finalError);
        },
      },
    );
  }

  async forkComplete(context: Context, instruction: string, options: ModelRequestOptions): Promise<string> {
    /* The fork keeps the live prefix intact and only appends the instruction,
     * so the provider's cached prefix still matches. Tools stay in the request
     * to preserve that prefix, but this method never executes a tool call. */
    const forked: Context = {
      ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
      messages: [...context.messages, { role: "user", content: instruction, timestamp: Date.now() }],
      ...(context.tools === undefined ? {} : { tools: context.tools }),
    };
    const message = await this.stream(forked, options);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new Error(message.errorMessage ?? `Forked request stopped with ${message.stopReason}`);
    }
    if (message.stopReason === "toolUse" || message.content.some((block) => block.type === "toolCall")) {
      throw new Error("Forked summary requested a tool; summary forks are read-only and tools were not executed");
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    if (!text) throw new Error("Forked request returned no text");
    return text;
  }

  async completeText(systemPrompt: string, prompt: string, options: ModelRequestOptions): Promise<string> {
    const message = await retryAssistantCall(
      async () =>
        this.models.completeSimple(
          this.model,
          {
            systemPrompt,
            messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
          },
          {
            signal: options.signal,
            ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
            ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
            maxRetries: 0,
            sessionId: options.sessionId ?? this.cacheKey,
            ...(this.resolveRetention(options) === undefined
              ? {}
              : { cacheRetention: this.resolveRetention(options)! }),
          },
        ),
      {
        enabled: true,
        maxRetries: options.maxRetries ?? DEFAULT_MODEL_MAX_RETRIES,
        baseDelayMs: options.retryBaseDelayMs ?? DEFAULT_MODEL_RETRY_BASE_DELAY_MS,
      },
      options.signal,
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
  private readonly configuredModelKeys: ReadonlySet<string> | undefined;

  constructor(
    private readonly models: Models,
    configuredModels?: readonly { providerId: string; modelId: string }[],
  ) {
    this.configuredModelKeys = configuredModels === undefined
      ? undefined
      : new Set(configuredModels.map((model) => modelKey(model.providerId, model.modelId)));
  }

  list(providerId?: string): ModelDescriptor[] {
    const models = this.models.getModels(providerId).filter((model) =>
      this.configuredModelKeys === undefined || this.configuredModelKeys.has(modelKey(model.provider, model.id)),
    );
    return this.describe(models);
  }

  listAll(providerId?: string): ModelDescriptor[] {
    return this.describe(this.models.getModels(providerId));
  }

  private describe(models: readonly Model<Api>[]): ModelDescriptor[] {
    return models
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
      ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
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
  const configuredModels: Array<{ providerId: string; modelId: string }> = [];
  for (const [customProviderId, config] of Object.entries(providers)) {
    registerCustomProvider(models, customProviderId, config);
    configuredModels.push(...config.models.map((model) => ({ providerId: customProviderId, modelId: model.id })));
  }
  return new PiModelCatalog(models, configuredModels);
}

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`;
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
