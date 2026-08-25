import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxThinking,
  fauxToolCall,
  type AssistantMessage,
  type Context,
  type Message,
} from "@earendil-works/pi-ai";
import { ContextCompactor } from "../../src/agent/compaction.js";
import type { ModelClient, ModelRequestOptions } from "../../src/agent/model-client.js";
import { SessionLogStore } from "../../src/session/log-store.js";
import { SessionService } from "../../src/session/service.js";

class RecordingModel implements ModelClient {
  readonly modelId = "recording";
  readonly providerId = "test";
  readonly contextWindow = 200_000;
  readonly maxOutputTokens = 4_000;
  readonly forks: Array<{ context: Context; instruction: string; reasoning: ModelRequestOptions["reasoning"] }> = [];

  async stream(_context: Context): Promise<AssistantMessage> {
    throw new Error("compaction must fork, not stream directly");
  }

  async completeText(): Promise<string> {
    throw new Error("compaction must not use isolated completeText");
  }

  async forkComplete(context: Context, instruction: string, options: ModelRequestOptions): Promise<string> {
    this.forks.push({ context, instruction, reasoning: options.reasoning });
    return `project state v${this.forks.length}`;
  }
}

function user(content: string, timestamp: number): Message {
  return { role: "user", content, timestamp };
}

function forkContext(messages: Message[]): Context {
  return { systemPrompt: "You are thread.", messages, tools: [] };
}

test("compaction forks the live context and updates the previous project state", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-compaction-"));
  const store = await SessionLogStore.open({
    rootPath: path.join(fixture, "workspace"),
    sidecarRoot: path.join(fixture, "sidecar"),
  });
  t.after(async () => {
    await store.close();
    await rm(fixture, { recursive: true, force: true });
  });
  const session = new SessionService(store);
  const model = new RecordingModel();
  const compactor = new ContextCompactor(session, model, { reasoning: "high" });
  const day = new Date(2026, 7, 23, 12).getTime();
  const messages: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "first durable requirement" },
        { type: "image", mimeType: "image/png", data: "secret-image-bytes" },
      ],
      timestamp: day + 1,
    },
    fauxAssistantMessage(
      [
        fauxThinking("hidden assistant thinking"),
        fauxToolCall("read", { path: "important.txt" }, { id: "call_1" }),
      ],
      { stopReason: "toolUse", timestamp: day + 2 },
    ),
    {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "visible tool evidence" }],
      details: { rawDuplicate: "raw tool details" },
      isError: false,
      timestamp: day + 3,
    },
    fauxAssistantMessage("first work complete", { timestamp: day + 4 }),
    user("second requirement", day + 5),
    fauxAssistantMessage("second result", { timestamp: day + 6 }),
    user("third requirement", day + 7),
    fauxAssistantMessage("third result", { timestamp: day + 8 }),
    user("fourth requirement", day + 9),
    fauxAssistantMessage("fourth result", { timestamp: day + 10 }),
  ];

  const first = await compactor.compact(
    "main",
    messages,
    10_000,
    100_000,
    new AbortController().signal,
    {},
    "manual",
    undefined,
    forkContext(messages),
  );
  assert.ok(first);
  assert.equal(model.forks[0]!.reasoning, "high");
  // The fork reuses the live prefix verbatim, so the model reads what it
  // actually experienced instead of a projected transcript.
  assert.equal(model.forks[0]!.context.messages, messages);
  assert.equal(model.forks[0]!.context.systemPrompt, "You are thread.");
  assert.match(model.forks[0]!.instruction, /Compact this conversation into a project state document/);
  assert.match(model.forks[0]!.instruction, /- \[YYYY-MM-DD HH\] \(interaction content\)/);
  assert.match(model.forks[0]!.instruction, /keep at most the 10\s+most recent entries/);

  const active: Message[] = [
    {
      role: "user",
      content: `[Summary of earlier project-session context]\n${first.entry.summary}`,
      timestamp: day + 11,
    },
    ...first.entry.retainedTail,
    user("fifth requirement", day + 12),
    fauxAssistantMessage("fifth result", { timestamp: day + 13 }),
  ];
  const second = await compactor.compact(
    "main",
    active,
    10_000,
    100_000,
    new AbortController().signal,
    {},
    "manual",
    undefined,
    forkContext(active),
  );
  assert.ok(second);
  assert.match(model.forks[1]!.instruction, /Re-evaluate that previous long-term\s+memory/);
  assert.match(model.forks[1]!.instruction, /already contains a previous project state/);
  assert.equal(model.forks[1]!.context.messages, active);
});

test("compaction fails loudly when the fork cannot fit in the context window", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-compaction-overflow-"));
  const store = await SessionLogStore.open({
    rootPath: path.join(fixture, "workspace"),
    sidecarRoot: path.join(fixture, "sidecar"),
  });
  t.after(async () => {
    await store.close();
    await rm(fixture, { recursive: true, force: true });
  });
  const session = new SessionService(store);
  const model = new RecordingModel();
  const compactor = new ContextCompactor(session, model, { maxSummaryTokens: 4_000 });
  const day = new Date(2026, 7, 23, 12).getTime();
  // One oversized turn can jump past the ratio trigger; the fork then cannot be
  // sent, and compaction must say so instead of silently degrading.
  const huge = "x".repeat(900_000);
  const messages: Message[] = [
    user("first requirement", day + 1),
    fauxAssistantMessage("first result", { timestamp: day + 2 }),
    user("second requirement", day + 3),
    fauxAssistantMessage(huge, { timestamp: day + 4 }),
    user("third requirement", day + 5),
    fauxAssistantMessage("third result", { timestamp: day + 6 }),
  ];
  await assert.rejects(
    compactor.compact(
      "main",
      messages,
      190_000,
      100_000,
      new AbortController().signal,
      {},
      "manual",
      undefined,
      forkContext(messages),
    ),
    /too large to compact/,
  );
  assert.equal(model.forks.length, 0);
});
