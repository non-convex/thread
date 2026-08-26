import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, type AssistantMessage, type Context, type Message } from "@earendil-works/pi-ai";
import {
  ContextCompactor,
  formatWorkspaceDiffStat,
  WORKSPACE_DIFF_MAX_BYTES,
} from "../../src/agent/compaction.js";
import type { ModelClient, ModelRequestOptions } from "../../src/agent/model-client.js";
import { SessionLogStore } from "../../src/session/log-store.js";
import { SessionService } from "../../src/session/service.js";

class RecordingModel implements ModelClient {
  readonly modelId = "recording";
  readonly providerId = "test";
  readonly contextWindow = 200_000;
  readonly maxOutputTokens = 4_000;
  readonly forks: Array<{ context: Context; instruction: string; options: ModelRequestOptions }> = [];

  async stream(): Promise<AssistantMessage> {
    throw new Error("summary must use a fork");
  }

  async completeText(): Promise<string> {
    throw new Error("summary must not use an isolated prompt");
  }

  async forkComplete(context: Context, instruction: string, options: ModelRequestOptions): Promise<string> {
    this.forks.push({ context, instruction, options });
    return `project state v${this.forks.length}`;
  }
}

async function append(session: SessionService, message: Message): Promise<string> {
  const entry = await session.appendEntry("main", {
    id: `entry_${crypto.randomUUID().replaceAll("-", "")}`,
    sessionId: session.store.sessionId,
    type: "message",
    message,
  });
  return entry.id;
}

test("project-state squash forks the exact prefix and creates a new root path", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-squash-"));
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
  const ids: string[] = [];
  for (let turn = 1; turn <= 4; turn++) {
    ids.push(await append(session, { role: "user", content: `requirement ${turn}`, timestamp: turn * 2 }));
    ids.push(await append(session, fauxAssistantMessage(`result ${turn}`, { timestamp: turn * 2 + 1 })));
  }
  const leaf = session.projection.lanes.get("main")!;
  const built = session.buildContext(leaf);
  const tools = [{ name: "read", description: "read", parameters: { type: "object" as const, properties: {} } }];
  const context: Context = { systemPrompt: "You are thread.", messages: built.messages, tools };
  const draft = await compactor.createProjectStateDraft({
    built,
    requestTokensBefore: 10_000,
    retainedTailBudgetTokens: 100_000,
    workspaceDiffStat: "total: 0 file(s), +0 -0, 0 binary",
    signal: new AbortController().signal,
    forkContext: context,
  });
  assert.ok(draft);
  assert.equal(model.forks[0]!.context, context, "the live context object is passed through unchanged");
  assert.equal(model.forks[0]!.context.tools, tools, "tool definitions remain in the fork prefix");
  assert.equal(model.forks[0]!.options.reasoning, "high");
  assert.match(model.forks[0]!.instruction, /read-only summary branch/i);
  assert.match(model.forks[0]!.instruction, /Do not call or request any tool/i);
  assert.match(model.forks[0]!.instruction, /retained raw tail starts at user message #2/i);
  // The two additional sections must survive with their bounds and their
  // deliberately strict admission rules.
  assert.match(model.forks[0]!.instruction, /`## Lessons learned`/);
  assert.match(model.forks[0]!.instruction, /`## Notes worth keeping`/);
  assert.match(model.forks[0]!.instruction, /Lessons learned contains at most 10 entries/);
  assert.match(model.forks[0]!.instruction, /Notes worth keeping contains at most 10 entries/);
  assert.match(model.forks[0]!.instruction, /leave the section empty rather than filling it/);
  assert.match(model.forks[0]!.instruction, /leave the section empty when nothing qualifies/);
  assert.deepEqual(draft.retainedTail.map((item) => item.sourceEntryId), ids.slice(2));

  const firstTurnDraft = await compactor.createIncrementalDraft({
    built,
    selectedUserEntryId: ids[0]!,
    requestTokensBefore: 10_000,
    workspaceDiffStat: "total: 0 file(s), +0 -0, 0 binary",
    signal: new AbortController().signal,
    forkContext: context,
  });
  assert.equal(firstTurnDraft.summaryKind, "incremental");
  assert.equal(firstTurnDraft.summarizedMessages, built.messages.length);
  assert.match(model.forks[1]!.instruction, /selected boundary is user message #1/i);
  // An incremental summary continues from an existing path, so it must not
  // regenerate the project-state document or its sections.
  assert.doesNotMatch(model.forks[1]!.instruction, /`## Lessons learned`/);
  assert.doesNotMatch(model.forks[1]!.instruction, /`## Notes worth keeping`/);

  const squash = await compactor.appendDraft("main", null, leaf, draft);
  assert.deepEqual(session.pathTo(squash.id).map((entry) => entry.id), [squash.id]);
  const after = session.buildContext(squash.id);
  assert.equal(after.messages.length, after.origins.length);
  assert.equal(after.rootProjectState?.summary, "project state v1");
  assert.deepEqual(after.origins.slice(1).map((origin) => origin.entryId), ids.slice(2));
  assert.ok(after.origins.slice(1).every((origin) => origin.kind === "retained" && origin.containerEntryId === squash.id));
});

test("squash fails loudly when the exact fork cannot fit", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-squash-overflow-"));
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
  for (let turn = 1; turn <= 3; turn++) {
    await append(session, { role: "user", content: `requirement ${turn}`, timestamp: turn * 2 });
    await append(session, fauxAssistantMessage(turn === 1 ? "x".repeat(900_000) : `result ${turn}`));
  }
  const built = session.buildContext(session.projection.lanes.get("main")!);
  const context: Context = { systemPrompt: "You are thread.", messages: built.messages, tools: [] };
  await assert.rejects(
    compactor.createProjectStateDraft({
      built,
      requestTokensBefore: 190_000,
      retainedTailBudgetTokens: 100_000,
      workspaceDiffStat: "none",
      signal: new AbortController().signal,
      forkContext: context,
    }),
    /too large to squash/,
  );
  assert.equal(model.forks.length, 0);
});

test("workspace diffstat is escaped, bounded and retains totals", () => {
  const files = Array.from({ length: 140 }, (_, index) => ({
    path: index === 0 ? "bad\n```prompt.md" : `src/${"x".repeat(100)}-${index}.ts`,
    status: "modified" as const,
    additions: index + 1,
    deletions: 1,
    binary: false,
  }));
  const output = formatWorkspaceDiffStat(files);
  assert.ok(Buffer.byteLength(output, "utf8") <= WORKSPACE_DIFF_MAX_BYTES);
  assert.match(output, /total: 140 file\(s\), \+9870 -140/);
  assert.match(output, /bad\\n```prompt\.md/);
  assert.match(output, /truncated:/);
});

test("explicit-parent append rejects stale lanes and invalid parents", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-entry-parent-"));
  const store = await SessionLogStore.open({
    rootPath: path.join(fixture, "workspace"),
    sidecarRoot: path.join(fixture, "sidecar"),
  });
  t.after(async () => {
    await store.close();
    await rm(fixture, { recursive: true, force: true });
  });
  const session = new SessionService(store);
  const first = await append(session, { role: "user", content: "first", timestamp: 1 });
  await assert.rejects(
    session.appendEntryAt("main", null, {
      id: "entry_stale",
      sessionId: session.store.sessionId,
      type: "message",
      message: { role: "user", content: "stale", timestamp: 2 },
    }, { expectedLeafId: null }),
    /lane main moved/,
  );
  await assert.rejects(
    session.appendEntryAt("main", "entry_missing", {
      id: "entry_missing_parent",
      sessionId: session.store.sessionId,
      type: "message",
      message: { role: "user", content: "missing", timestamp: 2 },
    }, { expectedLeafId: first }),
    /missing parent/,
  );
  await assert.rejects(
    session.appendEntryAt("main", "entry_self", {
      id: "entry_self",
      sessionId: session.store.sessionId,
      type: "message",
      message: { role: "user", content: "cycle", timestamp: 2 },
    }, { expectedLeafId: first }),
    /missing parent|own parent/,
  );
});
