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

  constructor(private readonly client: ModelClient) {
    this.modelLabel = `${client.providerId}/${client.modelId}`;
  }

  run(request: SemanticRequest): Promise<string> {
    return this.client.completeText(request.systemPrompt, request.prompt, {
      signal: request.signal,
      maxTokens: request.maxTokens,
    });
  }
}
