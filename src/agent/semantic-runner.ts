import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelClient } from "./model-client.js";

export interface SemanticRequest {
  systemPrompt: string;
  prompt: string;
  maxTokens: number;
  signal: AbortSignal;
}

export interface SemanticRunner {
  readonly modelLabel: string;
  run(request: SemanticRequest): Promise<string>;
}

export class ModelSemanticRunner implements SemanticRunner {
  readonly modelLabel: string;

  constructor(
    private readonly client: ModelClient,
    private readonly reasoning?: ThinkingLevel,
  ) {
    this.modelLabel = `${client.providerId}/${client.modelId}${reasoning ? `:${reasoning}` : ":off"}`;
  }

  run(request: SemanticRequest): Promise<string> {
    return this.client.completeText(request.systemPrompt, request.prompt, {
      signal: request.signal,
      maxTokens: request.maxTokens,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    });
  }
}
