import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxText, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import type { ModelClient, ModelRequestOptions } from "../../src/core/agent/model-client.js";

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

export async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-runtime-"));
  const rootPath = path.join(directory, "project");
  const stateDirectory = path.join(directory, "state");
  await mkdir(rootPath);
  return {
    directory,
    rootPath,
    stateDirectory,
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

export class ScriptedModel implements ModelClient {
  readonly modelId = "embedding-test";
  readonly providerId = "test";
  readonly contextWindow = 128_000;
  readonly maxOutputTokens = 8_192;
  readonly contexts: Context[] = [];
  closes = 0;

  constructor(private readonly respond: (
    context: Context,
    options: ModelRequestOptions,
    call: number,
  ) => Promise<AssistantMessage> = async () => fauxAssistantMessage(fauxText("ok"))) {}

  stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage> {
    this.contexts.push(structuredClone(context));
    return this.respond(context, options, this.contexts.length);
  }

  // An injected client can own additional resources; the host owns their lifetime.
  async close(): Promise<void> { this.closes++; }
}

export const skills = { skills: [], diagnostics: [] };
