import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import type { ModelClient, ModelRequestOptions } from "../src/agent/model-client.js";
import { ThreadApp } from "../src/app.js";
import { GLOBAL_MEMORY_FILE, GlobalMemorySnapshots } from "../src/global-memory.js";

class CapturingModel implements ModelClient {
  readonly modelId = "memory-capture";
  readonly providerId = "test";
  readonly contextWindow = 128_000;
  readonly maxOutputTokens = 8_192;
  readonly reasoning = false;
  readonly contexts: Context[] = [];

  async stream(context: Context, _options: ModelRequestOptions): Promise<AssistantMessage> {
    this.contexts.push(structuredClone(context));
    return fauxAssistantMessage(fauxText("ok"));
  }
}

async function fixture(): Promise<{ root: string; home: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-global-memory-"));
  const root = path.join(directory, "project");
  const home = path.join(directory, "home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  return {
    root,
    home,
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

async function withThreadHome<T>(home: string, operation: () => Promise<T>): Promise<T> {
  const previous = process.env.THREAD_HOME;
  process.env.THREAD_HOME = home;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.THREAD_HOME;
    else process.env.THREAD_HOME = previous;
  }
}

test("global memory is a fixed per-Session system-prompt snapshot refreshed by /new and restart", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const memoryPath = path.join(values.home, GLOBAL_MEMORY_FILE);
  await writeFile(memoryPath, "- [2026-09-03] stable-memory-v1\n", "utf8");
  const expandedMemory = `- [2026-09-03] stable-memory-v2 ${"long-lived-detail ".repeat(600)}\n`;

  await withThreadHome(values.home, async () => {
    const firstModel = new CapturingModel();
    const app = await ThreadApp.open({
      rootPath: values.root,
      search: { semantic: false },
      model: firstModel,
      skills: { skills: [], diagnostics: [] },
    });
    const firstSession = app.sessionTree.activeSession.id;
    try {
      const firstBudget = app.contextOccupancy()!.requestTokens;
      assert.equal(app.agentProfiles.get("main")?.model, firstModel);
      await app.handleInput("first", { signal: new AbortController().signal });
      assert.match(firstModel.contexts.at(-1)!.systemPrompt, /stable-memory-v1/);

      await writeFile(memoryPath, expandedMemory, "utf8");
      await app.handleInput("second", { signal: new AbortController().signal });
      assert.match(firstModel.contexts.at(-1)!.systemPrompt, /stable-memory-v1/);
      assert.doesNotMatch(firstModel.contexts.at(-1)!.systemPrompt, /stable-memory-v2/);

      await app.handleInput("/new", { signal: new AbortController().signal });
      const secondSession = app.sessionTree.activeSession.id;
      assert.ok(app.contextOccupancy()!.requestTokens > firstBudget, "the refreshed memory is included in the request budget");
      await app.handleInput("new session", { signal: new AbortController().signal });
      assert.match(firstModel.contexts.at(-1)!.systemPrompt, /stable-memory-v2/);

      await app.handleInput(`/session ${firstSession}`, { signal: new AbortController().signal });
      await app.handleInput("old session", { signal: new AbortController().signal });
      assert.match(firstModel.contexts.at(-1)!.systemPrompt, /stable-memory-v1/);
      assert.doesNotMatch(firstModel.contexts.at(-1)!.systemPrompt, /stable-memory-v2/);

      assert.equal((await app.recall.search(["stable-memory-v1"])).hits.length, 0);
      assert.doesNotMatch(JSON.stringify(app.liveContextMessages()), /stable-memory-v[12]/);
      await app.handleInput(`/session ${secondSession}`, { signal: new AbortController().signal });
    } finally {
      await app.close();
    }

    const restartedModel = new CapturingModel();
    const restarted = await ThreadApp.open({
      rootPath: values.root,
      model: restartedModel,
      skills: { skills: [], diagnostics: [] },
    });
    try {
      await restarted.handleInput("after restart", { signal: new AbortController().signal });
      assert.match(restartedModel.contexts.at(-1)!.systemPrompt, /stable-memory-v2/);
      assert.doesNotMatch(restartedModel.contexts.at(-1)!.systemPrompt, /stable-memory-v1/);
      await restarted.handleInput(`/session ${firstSession}`, { signal: new AbortController().signal });
      await restarted.handleInput("old session after restart", { signal: new AbortController().signal });
      assert.match(restartedModel.contexts.at(-1)!.systemPrompt, /stable-memory-v2/);
    } finally {
      await restarted.close();
    }
  });
});

test("global memory read errors keep the last successful snapshot and expose a diagnostic", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const memoryPath = path.join(values.home, GLOBAL_MEMORY_FILE);
  await writeFile(memoryPath, "remembered\n", "utf8");
  const snapshots = await GlobalMemorySnapshots.open(["session"], memoryPath);

  await rm(memoryPath);
  await mkdir(memoryPath);
  assert.equal(await snapshots.loadFresh(), "remembered\n");
  assert.match(snapshots.diagnostic ?? "", /Cannot read global memory/);
  assert.equal(snapshots.snapshot("session"), "remembered\n");

  await rm(memoryPath, { recursive: true });
  assert.equal(await snapshots.loadFresh(), "");
  assert.equal(snapshots.diagnostic, undefined);
});

test("the Main agent can write the exact memory file but not a neighboring external file", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const memoryPath = path.join(values.home, GLOBAL_MEMORY_FILE);
  const siblingPath = path.join(values.home, "not-memory.md");

  class WritingModel extends CapturingModel {
    override async stream(context: Context, _options: ModelRequestOptions): Promise<AssistantMessage> {
      this.contexts.push(structuredClone(context));
      if (this.contexts.length === 1) {
        return fauxAssistantMessage([
          fauxToolCall("write", { path: memoryPath, content: "- [2026-09-03] exact memory\n" }, { id: "memory-write" }),
          fauxToolCall("write", { path: siblingPath, content: "forbidden\n" }, { id: "sibling-write" }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(fauxText("done"));
    }
  }

  await withThreadHome(values.home, async () => {
    const app = await ThreadApp.open({
      rootPath: values.root,
      model: new WritingModel(),
      skills: { skills: [], diagnostics: [] },
    });
    try {
      const result = await app.handleInput("remember this", { signal: new AbortController().signal });
      assert.equal(result.kind, "turn");
      assert.equal(await readFile(memoryPath, "utf8"), "- [2026-09-03] exact memory\n");
      await assert.rejects(readFile(siblingPath, "utf8"), /ENOENT/);
      const toolResults = app.sessionTree.messagesForTurn(result.result.turn.id)
        .filter((message) => message.role === "toolResult");
      assert.equal(toolResults.find((message) => message.role === "toolResult" && message.toolCallId === "memory-write")?.isError, false);
      assert.equal(toolResults.find((message) => message.role === "toolResult" && message.toolCallId === "sibling-write")?.isError, true);
    } finally {
      await app.close();
    }
  });
});
