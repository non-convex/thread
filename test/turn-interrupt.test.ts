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
import { INTERRUPTED_TOOL_RESULT, needsPlaceholderAssistant, unmatchedToolCalls } from "../src/session-tree/conversation-seal.js";
import { singletonResource } from "../src/tools/execution.js";
import type { AgentTool } from "../src/tools/types.js";

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
  readonly modelId = "interrupt";
  readonly providerId = "test";
  readonly contextWindow = 128_000;
  readonly maxOutputTokens = 8_192;
  readonly reasoning = false;
  readonly contexts: Context[] = [];

  abstract stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage>;

  async completeText(): Promise<string> {
    return "summary";
  }

  async forkComplete(): Promise<string> {
    return "summary";
  }
}

test("unmatched tool calls and a trailing user message need a sealed prefix", () => {
  const call = fauxToolCall("read", {}, { id: "call-1" });
  assert.deepEqual(
    unmatchedToolCalls([
      { role: "user", content: "go", timestamp: 1 },
      fauxAssistantMessage([call], { stopReason: "toolUse" }),
    ]).map((item) => item.id),
    ["call-1"],
  );
  assert.equal(needsPlaceholderAssistant([{ role: "user", content: "go", timestamp: 1 }]), true);
  assert.equal(
    needsPlaceholderAssistant([
      { role: "user", content: "go", timestamp: 1 },
      fauxAssistantMessage(fauxText("hi"), { stopReason: "aborted" }),
    ]),
    false,
  );
});

test("interrupting a turn keeps it on the live path so the next prompt can continue", async (t) => {
  const values = await fixture("thread-interrupt-continue-");
  t.after(values.cleanup);

  await withThreadHome(values.home, async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const call = fauxToolCall("probe_wait", { value: "blocked" }, { id: "call-wait" });
    let modelCalls = 0;
    const model = new class extends ScriptedModel {
      async stream(context: Context, _options: ModelRequestOptions): Promise<AssistantMessage> {
        this.contexts.push(structuredClone(context));
        modelCalls++;
        if (modelCalls === 1) return fauxAssistantMessage([call], { stopReason: "toolUse" });
        return fauxAssistantMessage(fauxText("continued"));
      }
    }();

    const tool: AgentTool<{ value: string }> = {
      name: "probe_wait",
      description: "Test-only blocking tool",
      parameters: Type.Object({ value: Type.String() }),
      replay: "never",
      execution: {
        effect: "process",
        mode: "parallel",
        resources: (args) => singletonResource("test-probe", args.value, "write"),
      },
      async execute(_args, context) {
        started.resolve();
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(context.signal.reason ?? new DOMException("Aborted", "AbortError"));
          if (context.signal.aborted) {
            onAbort();
            return;
          }
          context.signal.addEventListener("abort", onAbort, { once: true });
          release.promise.then(() => {
            context.signal.removeEventListener("abort", onAbort);
            resolve();
          }, reject);
        });
        return { content: "should not finish", isError: false };
      },
    };

    const app = await ThreadApp.open({ rootPath: values.root, model, skills: { skills: [], diagnostics: [] } });
    app.extensionApi.registerTool(tool);
    const controller = new AbortController();
    try {
      const running = app.handleInput("do work", { signal: controller.signal });
      await started.promise;
      controller.abort();
      const result = await running;
      assert.equal(result.kind, "turn");
      if (result.kind !== "turn") return;
      assert.equal(result.result.outcome, "interrupted");
      const interruptedId = result.result.turn.id;
      assert.equal(app.sessionTree.activeLiveTip, interruptedId);

      const messages = app.sessionTree.messagesForTurn(interruptedId);
      const roles = messages.map((message) => message.role);
      assert.deepEqual(roles, ["user", "assistant", "toolResult"]);
      const toolResult = messages.at(-1);
      assert.equal(toolResult?.role, "toolResult");
      if (toolResult?.role === "toolResult") {
        assert.equal(toolResult.toolCallId, "call-wait");
        assert.equal(toolResult.isError, true);
        assert.match(JSON.stringify(toolResult.content), new RegExp(INTERRUPTED_TOOL_RESULT));
      }

      const continued = await app.handleInput("keep going", { signal: new AbortController().signal });
      assert.equal(continued.kind, "turn");
      if (continued.kind !== "turn") return;
      assert.equal(continued.result.outcome, "completed");
      assert.equal(app.sessionTree.projection.turns.get(continued.result.turn.id)?.parentTurnId, interruptedId);

      const followUp = model.contexts[1]!;
      const followRoles = followUp.messages.map((message) => message.role);
      assert.ok(followRoles.includes("toolResult"));
      assert.equal(followUp.messages.at(-1)?.role, "user");
    } finally {
      release.resolve();
      await app.close();
    }
  });
});
