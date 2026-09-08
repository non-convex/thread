import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Type, fauxAssistantMessage, fauxText, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { AgentRuntime } from "../src/agent/runtime.js";
import type { ModelClient, ModelRequestOptions } from "../src/agent/model-client.js";
import { ToolCallExecutor } from "../src/agent/tool-call-executor.js";
import { TurnRunner } from "../src/agent/turn-runner.js";
import { AgentProfileRegistry } from "../src/agent/profile.js";
import { AgentTaskOrchestrator } from "../src/agent-task/orchestrator.js";
import { AgentTaskRepository } from "../src/agent-task/repository.js";
import { createImplementationWorkerProfile } from "../src/agent-task/profile.js";
import { ContextBuilder } from "../src/context/builder.js";
import { ContextCompactionService } from "../src/context/compaction/index.js";
import { DreamerScheduler } from "../src/dreamer/scheduler.js";
import { createDreamerProfile } from "../src/dreamer/profile.js";
import { ExtensionEvents } from "../src/extensions/events.js";
import { SessionTreeRepository } from "../src/session-tree/repository.js";
import { SessionTreeService } from "../src/session-tree/service.js";
import type { HostToolCall, HostToolPolicy } from "../src/runtime/policy.js";
import type { RuntimeEvent } from "../src/runtime/events.js";
import { ToolRegistry, type AgentTool } from "../src/tools/types.js";

function model(stream: ModelClient["stream"]): ModelClient {
  return { providerId: "test", modelId: "runtime-test", contextWindow: 128_000, maxOutputTokens: 8_192, reasoning: false, stream };
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function projectFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-runtime-execution-"));
  const rootPath = path.join(directory, "project");
  const statePath = path.join(directory, "state");
  await Promise.all([mkdir(rootPath), mkdir(statePath)]);
  return {
    directory,
    project: { id: "runtime-execution", rootPath, statePath },
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

async function runtimeFixture(client: ModelClient, tools: AgentTool[] = [], policy?: HostToolPolicy) {
  const fixture = await projectFixture();
  const repository = await SessionTreeRepository.open(fixture.project);
  const tree = new SessionTreeService(repository);
  await tree.initialize();
  const registry = new ToolRegistry();
  tools.forEach((tool) => registry.register(tool));
  const extensions = new ExtensionEvents();
  const executor = new ToolCallExecutor(fixture.project.rootPath, registry, extensions, policy ? { toolPolicy: policy } : {});
  const runner = new TurnRunner(client, tree, new ContextBuilder(tree), new ContextCompactionService(tree, client), registry, executor, extensions, "test", 8_192);
  return {
    ...fixture,
    tree, extensions,
    runtime: new AgentRuntime(tree, runner, extensions),
    cleanup: async () => { await repository.close(); await fixture.cleanup(); },
  };
}

function probe(execute: AgentTool["execute"]): AgentTool {
  return {
    name: "probe", description: "test tool", parameters: Type.Object({ value: Type.String() }), replay: "safe",
    execution: { effect: "read", mode: "parallel", resources: () => [] }, execute,
  };
}

test("step limit settles the last tool and persists an interrupted turn without another model request", async (t) => {
  let requests = 0;
  let effects = 0;
  const fixture = await runtimeFixture(model(async () => {
    requests++;
    return fauxAssistantMessage(fauxToolCall("probe", { value: "ok" }, { id: `probe-${requests}` }), { stopReason: "toolUse" });
  }), [probe(async () => { effects++; return { content: "done", isError: false }; })]);
  t.after(fixture.cleanup);
  const events: RuntimeEvent[] = [];
  const result = await fixture.runtime.run("bounded", { signal: new AbortController().signal, maxSteps: 2, onEvent: (event) => events.push(event) });
  assert.equal(result.limit, "maxSteps");
  assert.equal(result.outcome, "interrupted");
  assert.equal(result.turn.status, "interrupted");
  assert.equal(requests, 2);
  assert.equal(effects, 2);
  assert.equal(fixture.tree.messagesForTurn(result.turn.id).filter((message) => message.role === "toolResult").length, 2);
  const finished = events.find((event) => event.type === "turn_finished");
  assert.equal(finished?.turnId, result.turn.id);
  assert.equal(finished?.sessionId, result.turn.sessionId);
  assert.equal(finished?.type === "turn_finished" ? finished.limit : undefined, "maxSteps");
  const log = await readFile(path.join(fixture.project.statePath, "session-tree", "events.jsonl"), "utf8");
  assert.match(log, /"status":"interrupted"/);
  assert.match(log, /"toolCallId":"probe-2"/);
});

test("timeout requests cancellation and still waits for a running tool's cleanup", async (t) => {
  const started = gate();
  const cancelled = gate();
  const cleanup = gate();
  let toolFinished = false;
  const fixture = await runtimeFixture(model(async () => fauxAssistantMessage(fauxToolCall("probe", { value: "ok" }), { stopReason: "toolUse" })), [probe(async (_args, context) => {
    started.resolve();
    if (!context.signal.aborted) await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    cancelled.resolve();
    await cleanup.promise;
    toolFinished = true;
    return { content: "settled after cancellation", isError: false };
  })]);
  t.after(fixture.cleanup);
  let returned = false;
  const operation = fixture.runtime.run("timeout", { signal: new AbortController().signal, timeoutMs: 200 }).then((result) => { returned = true; return result; });
  try {
    await started.promise;
    await cancelled.promise;
    assert.equal(returned, false);
    assert.equal(toolFinished, false);
  } finally {
    cleanup.resolve();
  }
  const result = await operation;
  assert.equal(toolFinished, true);
  assert.equal(result.outcome, "interrupted");
  assert.equal(result.limit, "timeout");
});

test("host policy observes final rewritten arguments and identity; denial prevents the tool effect", async (t) => {
  const observed: HostToolCall[] = [];
  let executed = false;
  let requests = 0;
  const fixture = await runtimeFixture(model(async () => ++requests === 1
    ? fauxAssistantMessage(fauxToolCall("probe", { value: "original" }, { id: "policy-call" }), { stopReason: "toolUse" })
    : fauxAssistantMessage(fauxText("done"))), [probe(async () => { executed = true; return { content: "executed", isError: false }; })], (call) => {
      observed.push(call);
      return { allow: false, reason: "host blocked rewritten target" };
    });
  t.after(fixture.cleanup);
  fixture.extensions.on("before_tool_call", (event) => ({ ...event, args: { value: "rewritten" }, denied: false }));
  const result = await fixture.runtime.run("policy", { signal: new AbortController().signal });
  assert.equal(result.outcome, "completed");
  assert.equal(executed, false);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]!.args.value, "rewritten");
  assert.equal(observed[0]!.sessionId, result.turn.sessionId);
  assert.equal(observed[0]!.turnId, result.turn.id);
  assert.equal(observed[0]!.toolCallId, "policy-call");
  assert.equal(observed[0]!.agentId, "main");
  const entries = fixture.tree.entriesForTurn(result.turn.id);
  assert.ok(entries.some((entry) => entry.id === observed[0]!.assistantEntryId));
  assert.match(JSON.stringify(fixture.tree.messagesForTurn(result.turn.id)), /host blocked rewritten target/);
});

test("runtime observations keep persisted entry identity through streaming and ignore observer exceptions", async (t) => {
  const events: RuntimeEvent[] = [];
  const fixture = await runtimeFixture(model(async (_context: Context, options: ModelRequestOptions) => {
    options.onTextDelta?.("hello");
    options.onThinkingDelta?.("consider");
    return fauxAssistantMessage(fauxText("hello"));
  }));
  t.after(fixture.cleanup);
  const result = await fixture.runtime.run("events", {
    signal: new AbortController().signal,
    onEvent: (event) => { events.push(event); throw new Error("renderer failed"); },
  });
  assert.equal(result.outcome, "completed");
  const entry = fixture.tree.entriesForTurn(result.turn.id).find((entry) => entry.type === "message" && entry.message.role === "assistant");
  assert.ok(events.findIndex((event) => event.type === "turn_started") < events.findIndex((event) => event.type === "assistant_started"));
  for (const event of events.filter((event) => event.type === "assistant_started" || event.type === "assistant_text_delta" || event.type === "assistant_thinking_delta")) {
    assert.equal(event.entryId, entry?.id);
    assert.equal(event.sessionId, result.turn.sessionId);
    assert.equal(event.turnId, result.turn.id);
  }
  const context = events.find((event) => event.type === "context_updated");
  assert.ok(context && context.estimatedTokens > 0);
  assert.equal(context.contextWindow, 128_000);
  assert.equal("percent" in context, false);
});

test("failed durable turn admission never invokes the model or turn-start extensions", async (t) => {
  let modelStarted = false;
  let extensionStarted = false;
  const fixture = await runtimeFixture(model(async () => {
    modelStarted = true;
    return fauxAssistantMessage(fauxText("must not run"));
  }));
  t.after(fixture.cleanup);
  fixture.extensions.on("turn_start", () => { extensionStarted = true; });
  fixture.tree.repository.appendBatch = async () => { throw new Error("initial persistence failed"); };
  await assert.rejects(fixture.runtime.run("failed admission", { signal: new AbortController().signal }), /initial persistence failed/);
  assert.equal(modelStarted, false);
  assert.equal(extensionStarted, false);
});

test("asynchronous observers neither delay completion nor leak rejected promises", async (t) => {
  const fixture = await runtimeFixture(model(async () => fauxAssistantMessage(fauxText("done"))));
  t.after(fixture.cleanup);
  let rejectObserver!: (error: Error) => void;
  const observer = new Promise<void>((_resolve, reject) => { rejectObserver = reject; });
  const result = await fixture.runtime.run("async observer", {
    signal: new AbortController().signal,
    onEvent: () => observer,
  });
  assert.equal(result.outcome, "completed");
  rejectObserver(new Error("observer rejected after turn completion"));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("observing a tool start cannot mutate authorized arguments before execution", async (t) => {
  let requests = 0;
  let executedValue: unknown;
  const fixture = await runtimeFixture(model(async () => ++requests === 1
    ? fauxAssistantMessage(fauxToolCall("probe", { value: "authorized" }), { stopReason: "toolUse" })
    : fauxAssistantMessage(fauxText("done"))), [probe(async (args) => {
      executedValue = args.value;
      return { content: "done", isError: false };
    })], (call) => {
      assert.equal(call.args.value, "authorized");
      return { allow: true };
    });
  t.after(fixture.cleanup);
  const result = await fixture.runtime.run("immutable observer", {
    signal: new AbortController().signal,
    onEvent: (event) => { if (event.type === "tool_started") event.args.value = "observer changed"; },
    onUiEvent: (event) => { if (event.type === "tool_started") event.args.value = "legacy observer changed"; },
  });
  assert.equal(result.outcome, "completed");
  assert.equal(executedValue, "authorized");
});

test("worker tools inherit the host policy with their parent session and task identity", async (t) => {
  const fixture = await projectFixture();
  const repository = await AgentTaskRepository.open(fixture.project);
  let requests = 0;
  const observed: HostToolCall[] = [];
  const worker = createImplementationWorkerProfile(model(async () => ++requests === 1
    ? fauxAssistantMessage(fauxToolCall("write", { path: "denied.txt", content: "forbidden" }), { stopReason: "toolUse" })
    : fauxAssistantMessage(fauxText("done"))));
  const orchestrator = new AgentTaskOrchestrator(repository, new AgentProfileRegistry([worker]), fixture.project.rootPath, undefined, undefined, {
    sessionIdForTurn: () => "parent-session",
    toolPolicy: (call) => { observed.push(call); return { allow: false }; },
  });
  t.after(async () => { await orchestrator.close(); await fixture.cleanup(); });
  const signal = new AbortController().signal;
  const [task] = await orchestrator.delegate([{
    title: "test", objective: "test policy", guidance: ["write"], acceptanceCriteria: ["policy observed"], writeScope: [{ path: "denied.txt", kind: "file" }],
  }], { parentTurnId: "parent-turn", toolCallId: "delegate", signal });
  await orchestrator.waitTasks([task!.taskId], "all", signal);
  assert.equal(observed[0]!.sessionId, "parent-session");
  assert.equal(observed[0]!.turnId, "parent-turn");
  assert.equal(observed[0]!.taskId, task!.taskId);
  assert.equal(observed[0]!.agentId, "implementation-worker");
  await assert.rejects(readFile(path.join(fixture.project.rootPath, "denied.txt")), /ENOENT/);
});

test("autonomous Dreamer uses host policy and close waits for model settlement", async (t) => {
  const fixture = await projectFixture();
  const observed: HostToolCall[] = [];
  const started = gate();
  const cleanup = gate();
  let requests = 0;
  let signal: AbortSignal | undefined;
  const memoryPath = path.join(fixture.directory, "memory.md");
  const scheduler = new DreamerScheduler(fixture.project.rootPath, memoryPath, createDreamerProfile(model(async (_context, options) => {
    if (++requests === 1) return fauxAssistantMessage(fauxToolCall("write", { path: memoryPath, content: "forbidden" }), { stopReason: "toolUse" });
    signal = options.signal;
    started.resolve();
    await cleanup.promise;
    return fauxAssistantMessage(fauxText("done"));
  })), { idleTurns: 1, idleMs: 1, toolPolicy: (call) => { observed.push(call); return { allow: false }; } });
  t.after(async () => { cleanup.resolve(); await scheduler.close(); await fixture.cleanup(); });
  scheduler.recordTurn([{ role: "user", content: "remember this interaction", timestamp: Date.now() }]);
  await started.promise;
  let closed = false;
  const closing = scheduler.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(signal?.aborted, true);
  assert.equal(closed, false);
  assert.equal(observed[0]!.agentId, "dreamer");
  assert.equal(observed[0]!.sessionId, null);
  assert.equal(observed[0]!.turnId, null);
  cleanup.resolve();
  await closing;
  await assert.rejects(readFile(memoryPath), /ENOENT/);
});
