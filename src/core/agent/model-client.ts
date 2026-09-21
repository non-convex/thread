import {
  type Api, type AssistantMessage, type CacheRetention, type Context, type Message, type Model, type Models,
  type ModelThinkingLevel, type ThinkingLevel, type ToolCall, getSupportedThinkingLevels, retryAssistantCall,
} from "@earendil-works/pi-ai";
import type { ModelOverrideConfig } from "../config/model-config.js";
import { observeModelAttempt, type ModelAttemptEvent } from "./model-observation.js";

/** Retryable provider/transport errors, including unknown certificate verification errors via the Pi patch. */
export const DEFAULT_MODEL_MAX_RETRIES = 10;
export const DEFAULT_MODEL_RETRY_BASE_DELAY_MS = 500;

export interface ModelRetryCallbacks {
  onRetryScheduled?: (attempt: number, maxAttempts: number, delayMs: number, errorMessage: string) => void | Promise<void>;
  onRetryAttemptStart?: (attempt: number, maxAttempts: number) => void | Promise<void>;
  onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}
export interface ModelRequestOptions extends ModelRetryCallbacks {
  /** Read-only attempt observations, including failed responses before retry. */
  onAttempt?: (event: ModelAttemptEvent) => void | Promise<void>;
  /** Read-only copy after provider payload construction, before compression/transport continuation. Opt-in. */
  onProviderRequest?: (request: { api: string; payload: unknown; attempt: number }) => void | Promise<void>;
  signal: AbortSignal;
  maxTokens?: number;
  reasoning?: ThinkingLevel;
  /** Cache partition shared by matching request prefixes. Defaults to the client cacheKey. */
  sessionId?: string;
  /** Per-request cache lifetime; defaults to the client cacheRetention. */
  cacheRetention?: CacheRetention;
  /** Defaults to DEFAULT_MODEL_MAX_RETRIES. */
  maxRetries?: number;
  /** Initial exponential backoff; defaults to DEFAULT_MODEL_RETRY_BASE_DELAY_MS. */
  retryBaseDelayMs?: number;
  onTextDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  /** Complete streamed arguments, before the assistant response itself finishes. */
  onToolCallComplete?: (call: ToolCall, contentIndex: number) => void | Promise<void>;
}
export interface ModelClient {
  readonly modelId: string;
  readonly providerId: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning?: boolean;
  readonly supportedThinkingLevels?: readonly ModelThinkingLevel[];
  readonly cacheKey?: string;
  readonly cacheRetention?: CacheRetention | undefined;
  readonly acceptsImages?: boolean;
  stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage>;
}

/** Pi skips incomplete assistant responses; their tool results must be skipped with them. */
export function replayableMessages(messages: readonly Message[]): Message[] {
  const skippedCalls = new Set<string>();
  return messages.filter((message) => {
    if (message.role === "assistant") {
      const skip = message.stopReason === "aborted" || message.stopReason === "error";
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        if (skip) skippedCalls.add(block.id);
        else skippedCalls.delete(block.id);
      }
      return !skip;
    }
    return message.role !== "toolResult" || !skippedCalls.has(message.toolCallId);
  });
}

/** Streaming and retries for one selected model, independent of catalog discovery. */
export class PiModelClient implements ModelClient {
  readonly modelId: string;
  readonly providerId: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly reasoning: boolean;
  readonly supportedThinkingLevels: readonly ModelThinkingLevel[];
  readonly cacheKey: string;
  readonly acceptsImages: boolean;
  private readonly model: Model<Api>;

  constructor(
    private readonly models: Models,
    model: Model<Api>,
    cacheKey?: string,
    readonly cacheRetention: CacheRetention | undefined = undefined,
    override?: ModelOverrideConfig,
  ) {
    this.model = override ? { ...model, contextWindow: override.contextWindow } : model;
    this.modelId = this.model.id;
    this.providerId = this.model.provider;
    this.contextWindow = this.model.contextWindow;
    this.maxOutputTokens = this.model.maxTokens;
    this.reasoning = this.model.reasoning;
    this.supportedThinkingLevels = getSupportedThinkingLevels(this.model);
    this.cacheKey = cacheKey ?? `thread:${this.providerId}:${this.modelId}`;
    this.acceptsImages = this.model.input.includes("image");
  }

  withCacheKey(cacheKey: string): PiModelClient {
    return new PiModelClient(this.models, this.model, cacheKey, this.cacheRetention);
  }
  withCacheRetention(cacheRetention: CacheRetention | undefined): PiModelClient {
    return new PiModelClient(this.models, this.model, this.cacheKey, cacheRetention);
  }

  async stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage> {
    // Keep the durable history intact, including cancelled calls and their diagnostics.
    const replayContext = { ...context, messages: replayableMessages(context.messages) };
    const maxRetries = options.maxRetries ?? DEFAULT_MODEL_MAX_RETRIES;
    const baseDelayMs = options.retryBaseDelayMs ?? DEFAULT_MODEL_RETRY_BASE_DELAY_MS;
    const cacheRetention = options.cacheRetention ?? this.cacheRetention;
    let scheduledAttempt = 0;
    let attempt = 0;
    return retryAssistantCall(
      () => observeModelAttempt(++attempt, options, async (options) => {
        const stream = this.models.streamSimple(this.model, replayContext, {
          signal: options.signal,
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
          maxRetries: 0, // Retry above so observers see every attempt.
          sessionId: options.sessionId ?? this.cacheKey,
          ...(cacheRetention === undefined ? {} : { cacheRetention }),
          ...(options.onProviderRequest ? { onPayload: (payload: unknown, requestModel: Model<Api>) => {
            try {
              const pending = options.onProviderRequest?.({ api: requestModel.api, payload: structuredClone(payload), attempt });
              if (pending) void pending.catch(() => undefined);
            } catch { /* Diagnostics cannot change or reject the provider request. */ }
            return undefined;
          } } : {}),
        });
        for await (const event of stream) {
          switch (event.type) {
            case "text_delta": options.onTextDelta?.(event.delta); break;
            case "thinking_delta": options.onThinkingDelta?.(event.delta); break;
            case "toolcall_end": await options.onToolCallComplete?.(structuredClone(event.toolCall), event.contentIndex); break;
          }
        }
        return stream.result();
      }),
      { enabled: true, maxRetries, baseDelayMs }, options.signal,
      {
        onRetryScheduled: async (attempt, maxAttempts, delayMs, errorMessage) => {
          scheduledAttempt = attempt;
          await options.onRetryScheduled?.(attempt, maxAttempts, delayMs, errorMessage);
        },
        onRetryAttemptStart: async () => { await options.onRetryAttemptStart?.(scheduledAttempt, maxRetries); },
        onRetryFinished: async (success, attempt, finalError) => { await options.onRetryFinished?.(success, attempt, finalError); },
      },
    );
  }
}
