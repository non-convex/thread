import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type Context,
  type Message,
} from "@earendil-works/pi-ai";
import type { ModelClient, ModelRequestOptions } from "../src/agent/model-client.js";
import { createDreamerProfile } from "../src/dreamer/profile.js";
import { DreamerScheduler, dreamerConversation } from "../src/dreamer/scheduler.js";

class DreamerModel implements ModelClient {
  readonly modelId = "dreamer-test";
  readonly providerId = "test";
  readonly contextWindow = 32_000;
  readonly maxOutputTokens = 4_096;
  readonly reasoning = true;
  readonly supportedThinkingLevels = ["low"] as const;
  readonly contexts: Context[] = [];
  active = 0;
  maximumActive = 0;

  async stream(context: Context, _options: ModelRequestOptions): Promise<AssistantMessage> {
    this.contexts.push(structuredClone(context));
    this.active += 1;
    this.maximumActive = Math.max(this.maximumActive, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return fauxAssistantMessage(fauxText("review complete"));
    } finally {
      this.active -= 1;
    }
  }
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Dreamer");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function user(text: string, timestamp: number): Message {
  return { role: "user", content: text, timestamp };
}

test("Dreamer evidence excludes thinking, ordinary tool output, and tool arguments", () => {
  const ask = fauxToolCall("ask", { secretArgument: "exclude-ask-args" }, { id: "ask-1" });
  const read = fauxToolCall("read", { path: "exclude-read-args" }, { id: "read-1" });
  const messages: Message[] = [
    user("explicit user preference", 1),
    fauxAssistantMessage([
      { type: "thinking", thinking: "exclude private thinking" },
      { type: "text", text: "visible assistant context" },
      ask,
      read,
    ], { stopReason: "toolUse", timestamp: 2 }),
    {
      role: "toolResult",
      toolCallId: ask.id,
      toolName: ask.name,
      content: [fauxText("explicit answer")],
      isError: false,
      timestamp: 3,
    },
    {
      role: "toolResult",
      toolCallId: read.id,
      toolName: read.name,
      content: [fauxText("exclude ordinary output")],
      isError: false,
      timestamp: 4,
    },
  ];

  const evidence = dreamerConversation(messages);
  assert.match(evidence, /explicit user preference/);
  assert.match(evidence, /visible assistant context/);
  assert.match(evidence, /explicit answer/);
  assert.doesNotMatch(evidence, /private thinking|secretArgument|exclude-ask-args|exclude-read-args|ordinary output/);
});

test("Dreamer waits for the turn threshold and idle window, then runs compaction batches immediately", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-dreamer-scheduler-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const root = path.join(directory, "project");
  await mkdir(root, { recursive: true });
  const memoryPath = path.join(directory, ".THREAD.md");
  const model = new DreamerModel();
  const profile = createDreamerProfile(model);
  const scheduler = new DreamerScheduler(root, memoryPath, profile, {
    idleTurns: 2,
    idleMs: 20,
    maxRuntimeMs: 1_000,
  });
  t.after(() => scheduler.close());

  scheduler.recordTurn([user("turn one", 1)]);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(model.contexts.length, 0);

  scheduler.recordTurn([user("turn two", 2)]);
  await waitFor(() => model.contexts.length === 1);
  assert.equal(profile.thinkingLevel, "low");
  assert.deepEqual(profile.tools.list().map((tool) => tool.name), ["read", "write", "edit"]);
  assert.match(JSON.stringify(model.contexts[0]!.messages), /turn one/);
  assert.match(JSON.stringify(model.contexts[0]!.messages), /turn two/);

  scheduler.recordCompaction([user("compacted original content", 3)]);
  await waitFor(() => model.contexts.length === 2);
  assert.match(JSON.stringify(model.contexts[1]!.messages), /compacted original content/);
  assert.equal(model.maximumActive, 1, "only one Dreamer instance runs at a time");

  scheduler.setProfile(undefined);
  scheduler.recordCompaction([user("disabled content", 4)]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(model.contexts.length, 2);
  await assert.rejects(readFile(memoryPath, "utf8"), /ENOENT/);
});

test("foreground input safely cancels Dreamer and reschedules the unfinished batch", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-dreamer-cancel-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const root = path.join(directory, "project");
  await mkdir(root, { recursive: true });

  class InterruptibleModel extends DreamerModel {
    override async stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage> {
      this.contexts.push(structuredClone(context));
      if (this.contexts.length > 1) return fauxAssistantMessage(fauxText("retry complete"));
      await new Promise<void>((_resolve, reject) => {
        if (options.signal.aborted) return reject(options.signal.reason);
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
      return fauxAssistantMessage(fauxText("unreachable"));
    }
  }

  const model = new InterruptibleModel();
  const scheduler = new DreamerScheduler(root, path.join(directory, ".THREAD.md"), createDreamerProfile(model), {
    idleTurns: 1,
    idleMs: 1,
    maxRuntimeMs: 1_000,
  });
  t.after(() => scheduler.close());

  scheduler.recordCompaction([user("must survive cancellation", 1)]);
  await waitFor(() => model.contexts.length === 1);
  await scheduler.foregroundStarting();
  assert.equal(model.contexts.length, 1);
  scheduler.foregroundFinished();
  await waitFor(() => model.contexts.length === 2);
  assert.match(JSON.stringify(model.contexts[1]!.messages), /must survive cancellation/);
});

test("Dreamer retains a failed batch and reports the latest error before an idle retry", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-dreamer-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const root = path.join(directory, "project");
  await mkdir(root, { recursive: true });

  class FailingOnceModel extends DreamerModel {
    override async stream(context: Context, _options: ModelRequestOptions): Promise<AssistantMessage> {
      this.contexts.push(structuredClone(context));
      if (this.contexts.length === 1) throw new Error("temporary Dreamer failure");
      return fauxAssistantMessage(fauxText("retry complete"));
    }
  }

  const model = new FailingOnceModel();
  const scheduler = new DreamerScheduler(root, path.join(directory, ".THREAD.md"), createDreamerProfile(model), {
    idleTurns: 1,
    idleMs: 100,
    maxRuntimeMs: 1_000,
  });
  t.after(() => scheduler.close());

  scheduler.recordCompaction([user("retain after failure", 1)]);
  await waitFor(() => scheduler.lastError !== undefined);
  assert.match(scheduler.lastError ?? "", /temporary Dreamer failure/);
  await waitFor(() => model.contexts.length === 2);
  assert.match(JSON.stringify(model.contexts[1]!.messages), /retain after failure/);
  await waitFor(() => scheduler.lastError === undefined);
});

test("Dreamer can write only the exact global memory file", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-dreamer-memory-write-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const root = path.join(directory, "project");
  await mkdir(root, { recursive: true });
  const memoryPath = path.join(directory, ".THREAD.md");
  const siblingPath = path.join(directory, "other.md");

  class WritingDreamerModel extends DreamerModel {
    override async stream(context: Context, _options: ModelRequestOptions): Promise<AssistantMessage> {
      this.contexts.push(structuredClone(context));
      if (this.contexts.length === 1) {
        return fauxAssistantMessage([
          fauxToolCall("write", { path: memoryPath, content: "- [2026-09-03] remembered\n" }, { id: "memory" }),
          fauxToolCall("write", { path: siblingPath, content: "forbidden\n" }, { id: "sibling" }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(fauxText("done"));
    }
  }

  const model = new WritingDreamerModel();
  const scheduler = new DreamerScheduler(root, memoryPath, createDreamerProfile(model), {
    maxRuntimeMs: 1_000,
  });
  t.after(() => scheduler.close());
  scheduler.recordCompaction([user("I explicitly prefer concise answers", 1)]);
  await waitFor(() => model.contexts.length === 2);
  await waitFor(() => scheduler.lastError === undefined);
  assert.equal(await readFile(memoryPath, "utf8"), "- [2026-09-03] remembered\n");
  await assert.rejects(readFile(siblingPath, "utf8"), /ENOENT/);
});
