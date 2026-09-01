import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  Type,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import type { ModelClient, ModelRequestOptions } from "../src/agent/model-client.js";
import { ThreadApp } from "../src/app.js";
import { noResources } from "../src/tools/execution.js";
import type { AgentTool } from "../src/tools/types.js";

async function withHome<T>(home: string, operation: () => Promise<T>): Promise<T> {
  const before = process.env.THREAD_HOME;
  process.env.THREAD_HOME = home;
  try {
    return await operation();
  } finally {
    if (before === undefined) delete process.env.THREAD_HOME;
    else process.env.THREAD_HOME = before;
  }
}

test("a model retry cancels the old streamed batch and binds results only to the successful attempt", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-tool-retry-"));
  const root = path.join(directory, "project");
  const home = path.join(directory, "home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));

  await withHome(home, async () => {
    const oldCall = fauxToolCall("retry_read", { value: "old-attempt" }, { id: "old-call" });
    const finalCall = fauxToolCall("retry_read", { value: "successful-attempt" }, { id: "final-call" });
    const contexts: Context[] = [];
    let modelCalls = 0;
    const model: ModelClient = {
      modelId: "retry",
      providerId: "test",
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      reasoning: false,
      async stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage> {
        contexts.push(structuredClone(context));
        modelCalls++;
        if (modelCalls > 1) return fauxAssistantMessage(fauxText("done"));
        await options.onToolCallComplete?.(oldCall, 0);
        await options.onRetryScheduled?.(1, 2, 0, "transient failure");
        await options.onRetryAttemptStart?.(1, 2);
        await options.onToolCallComplete?.(finalCall, 0);
        return fauxAssistantMessage(finalCall, { stopReason: "toolUse" });
      },
      async completeText(): Promise<string> {
        return "summary";
      },
      async forkComplete(): Promise<string> {
        return "summary";
      },
    };
    const executions: string[] = [];
    const tool: AgentTool<{ value: string }> = {
      name: "retry_read",
      description: "Test retry batch ownership",
      parameters: Type.Object({ value: Type.String() }),
      replay: "safe",
      execution: { effect: "read", mode: "parallel", resources: noResources },
      async execute(args) {
        executions.push(args.value);
        return { content: args.value, isError: false };
      },
    };

    const app = await ThreadApp.open({ rootPath: root, model, skills: { skills: [], diagnostics: [] } });
    app.extensionApi.registerTool(tool);
    try {
      await app.handleInput("retry the provider", { signal: new AbortController().signal });
      assert.deepEqual(executions, ["old-attempt", "successful-attempt"]);
      const resultIds = contexts[1]!.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => message.role === "toolResult" ? message.toolCallId : "");
      assert.deepEqual(resultIds, ["final-call"]);
      const entries = app.sessionTree.entriesForTurn(app.sessionTree.activeLiveTip!);
      const executionEntries = entries.filter((entry) => entry.type === "tool_execution");
      assert.deepEqual(executionEntries.map((entry) => entry.toolCallId), ["old-call", "final-call"]);
      assert.notEqual(executionEntries[0]!.assistantEntryId, executionEntries[1]!.assistantEntryId);
      const assistant = entries.find((entry) => entry.type === "message" && entry.message.role === "assistant");
      assert.equal(executionEntries[1]!.assistantEntryId, assistant?.id);
    } finally {
      await app.close();
    }
  });
});
