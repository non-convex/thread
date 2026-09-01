import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ModelClient, ModelRequestOptions } from "../src/agent/model-client.js";
import { ThreadApp } from "../src/app.js";
import { singletonResource, workspacePathClaim } from "../src/tools/execution.js";
import type { AgentTool } from "../src/tools/types.js";
import type { UiEvent } from "../src/ui/events.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

async function fixture(prefix: string): Promise<{ root: string; home: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const root = path.join(directory, "project");
  const home = path.join(directory, "thread-home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  return {
    root,
    home,
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

async function withThreadHome<T>(home: string, operation: () => Promise<T>): Promise<T> {
  const before = process.env.THREAD_HOME;
  process.env.THREAD_HOME = home;
  try {
    return await operation();
  } finally {
    if (before === undefined) delete process.env.THREAD_HOME;
    else process.env.THREAD_HOME = before;
  }
}

abstract class ScriptedModel implements ModelClient {
  readonly modelId = "tool-concurrency";
  readonly providerId = "test";
  readonly contextWindow = 128_000;
  readonly maxOutputTokens = 8_192;
  readonly reasoning = false;

  abstract stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage>;

  async completeText(): Promise<string> {
    return "summary";
  }

  async forkComplete(): Promise<string> {
    return "summary";
  }
}

async function publishCall(options: ModelRequestOptions, call: ToolCall, contentIndex: number): Promise<void> {
  await options.onToolCallComplete?.(structuredClone(call), contentIndex);
}

test("read-effect tools start from the model stream, finish independently, and commit results in source order", async (t) => {
  const values = await fixture("thread-eager-tools-");
  t.after(values.cleanup);

  await withThreadHome(values.home, async () => {
    const responseGate = deferred<void>();
    const firstGate = deferred<void>();
    const bothStarted = deferred<void>();
    const calls = [
      fauxToolCall("probe_read", { value: "first" }, { id: "call-first" }),
      fauxToolCall("probe_read", { value: "second" }, { id: "call-second" }),
    ];
    let active = 0;
    let maxActive = 0;
    let modelResponseOpen = false;
    let modelCalls = 0;
    let app!: ThreadApp;
    const model = new class extends ScriptedModel {
      readonly contexts: Context[] = [];

      async stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage> {
        this.contexts.push(structuredClone(context));
        modelCalls++;
        if (modelCalls > 1) return fauxAssistantMessage(fauxText("done"));
        modelResponseOpen = true;
        await publishCall(options, calls[0]!, 0);
        await publishCall(options, calls[1]!, 1);
        await bothStarted.promise;
        await responseGate.promise;
        modelResponseOpen = false;
        return fauxAssistantMessage(calls, { stopReason: "toolUse" });
      }
    }();

    const tool: AgentTool<{ value: string }> = {
      name: "probe_read",
      description: "Test-only eager read",
      parameters: Type.Object({ value: Type.String() }),
      replay: "safe",
      execution: {
        effect: "read",
        mode: "parallel",
        resources: (args) => singletonResource("test-probe", args.value, "read"),
      },
      async execute(args) {
        const eventsPath = path.join(app.project.statePath, "session-tree", "events.jsonl");
        const durableLog = await readFile(eventsPath, "utf8");
        assert.match(durableLog, new RegExp(args.value === "first" ? "call-first" : "call-second"));
        assert.equal(modelResponseOpen, true, "read effect should execute before the provider response closes");
        active++;
        maxActive = Math.max(maxActive, active);
        if (active === 2) bothStarted.resolve();
        try {
          if (args.value === "first") await firstGate.promise;
          return { content: args.value, isError: false };
        } finally {
          active--;
        }
      },
    };

    app = await ThreadApp.open({ rootPath: values.root, model, skills: { skills: [], diagnostics: [] } });
    app.extensionApi.registerTool(tool);
    const events: UiEvent[] = [];
    try {
      const running = app.handleInput("run both reads", {
        signal: new AbortController().signal,
        onUiEvent: (event) => events.push(event),
      });
      await bothStarted.promise;
      assert.equal(maxActive, 2);
      assert.equal(modelResponseOpen, true);

      // The second call can finish while the first remains blocked.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const earlyFinishes = events.filter((event) => event.type === "tool_finished");
      assert.deepEqual(earlyFinishes.map((event) => event.type === "tool_finished" ? event.id : ""), ["call-second"]);

      firstGate.resolve();
      responseGate.resolve();
      await running;

      const finished = events.filter((event) => event.type === "tool_finished");
      assert.deepEqual(finished.map((event) => event.type === "tool_finished" ? event.id : ""), ["call-second", "call-first"]);
      const secondContextResults = model.contexts[1]!.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => message.role === "toolResult" ? message.toolCallId : "");
      assert.deepEqual(secondContextResults, ["call-first", "call-second"]);

      const entries = app.sessionTree.entriesForTurn(app.sessionTree.activeLiveTip!);
      const durableResults = entries
        .filter((entry) => entry.type === "message" && entry.message.role === "toolResult")
        .map((entry) => entry.type === "message" && entry.message.role === "toolResult" ? entry.message.toolCallId : "");
      assert.deepEqual(durableResults, ["call-first", "call-second"]);
    } finally {
      responseGate.resolve();
      firstGate.resolve();
      await app.close();
    }
  });
});

test("write effects wait for the durable assistant response and conflicting resources execute in source order", async (t) => {
  const values = await fixture("thread-deferred-tools-");
  t.after(values.cleanup);

  await withThreadHome(values.home, async () => {
    const responseGate = deferred<void>();
    const responsePrepared = deferred<void>();
    const firstStarted = deferred<void>();
    const firstGate = deferred<void>();
    const calls = [
      fauxToolCall("probe_write", { path: "shared.txt", value: "first" }, { id: "write-first" }),
      fauxToolCall("probe_write", { path: "shared.txt", value: "second" }, { id: "write-second" }),
    ];
    const executionOrder: string[] = [];
    let modelCalls = 0;
    const model = new class extends ScriptedModel {
      async stream(_context: Context, options: ModelRequestOptions): Promise<AssistantMessage> {
        modelCalls++;
        if (modelCalls > 1) return fauxAssistantMessage(fauxText("done"));
        await publishCall(options, calls[0]!, 0);
        await publishCall(options, calls[1]!, 1);
        responsePrepared.resolve();
        await responseGate.promise;
        return fauxAssistantMessage(calls, { stopReason: "toolUse" });
      }
    }();

    const tool: AgentTool<{ path: string; value: string }> = {
      name: "probe_write",
      description: "Test-only deferred write",
      parameters: Type.Object({ path: Type.String(), value: Type.String() }),
      replay: "never",
      execution: {
        effect: "write",
        mode: "parallel",
        resources: async (args, context) => [
          await workspacePathClaim(context.rootPath, args.path, "write", { forWrite: true }),
        ],
      },
      async execute(args, context) {
        executionOrder.push(`${args.value}:start`);
        if (args.value === "first") {
          firstStarted.resolve();
          await firstGate.promise;
        }
        await writeFile(path.join(context.rootPath, args.path), args.value, "utf8");
        executionOrder.push(`${args.value}:end`);
        return { content: args.value, isError: false };
      },
    };

    const app = await ThreadApp.open({ rootPath: values.root, model, skills: { skills: [], diagnostics: [] } });
    app.extensionApi.registerTool(tool);
    try {
      const running = app.handleInput("write twice", { signal: new AbortController().signal });
      await responsePrepared.promise;
      assert.deepEqual(executionOrder, [], "write effects must not start while the assistant response is open");
      await assert.rejects(readFile(path.join(values.root, "shared.txt"), "utf8"), /ENOENT/);

      responseGate.resolve();
      await firstStarted.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(executionOrder, ["first:start"], "the conflicting second write must wait for the first");

      firstGate.resolve();
      await running;
      assert.deepEqual(executionOrder, ["first:start", "first:end", "second:start", "second:end"]);
      assert.equal(await readFile(path.join(values.root, "shared.txt"), "utf8"), "second");
    } finally {
      responseGate.resolve();
      firstGate.resolve();
      await app.close();
    }
  });
});
