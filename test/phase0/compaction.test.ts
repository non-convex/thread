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
import type { ModelClient } from "../../src/agent/model-client.js";
import { SessionLogStore } from "../../src/session/log-store.js";
import { SessionService } from "../../src/session/service.js";

class RecordingModel implements ModelClient {
  readonly modelId = "recording";
  readonly providerId = "test";
  readonly contextWindow = 200_000;
  readonly maxOutputTokens = 4_000;
  readonly calls: Array<{ systemPrompt: string; prompt: string }> = [];

  async stream(_context: Context): Promise<AssistantMessage> {
    throw new Error("stream is not used by this test");
  }

  async completeText(systemPrompt: string, prompt: string): Promise<string> {
    this.calls.push({ systemPrompt, prompt });
    return `project state v${this.calls.length}`;
  }
}

function user(content: string, timestamp: number): Message {
  return { role: "user", content, timestamp };
}

test("compaction projects semantic evidence and updates the previous project state", async (t) => {
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
  const compactor = new ContextCompactor(session, model);
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
  );
  assert.ok(first);
  assert.match(model.calls[0]!.prompt, /first durable requirement/);
  assert.match(model.calls[0]!.prompt, /visible tool evidence/);
  assert.match(model.calls[0]!.prompt, /"date":"2026-08-23"/);
  assert.doesNotMatch(model.calls[0]!.prompt, /hidden assistant thinking|secret-image-bytes|raw tool details|"usage"/);

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
  );
  assert.ok(second);
  assert.match(model.calls[1]!.systemPrompt, /Re-evaluate the previous long-term memory/);
  assert.match(model.calls[1]!.prompt, /PREVIOUS PROJECT STATE/);
  assert.match(model.calls[1]!.prompt, /project state v1/);
  assert.match(model.calls[1]!.prompt, /NEW INTERACTIONS TO ABSORB/);
  assert.match(model.calls[1]!.prompt, /second requirement/);
});
