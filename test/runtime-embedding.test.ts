import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Type, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ThreadRuntime } from "../src/core/runtime/thread-runtime.js";
import type { ThreadRuntimeOptions } from "../src/core/runtime/options.js";
import type { RuntimeEvent } from "../src/core/runtime/events.js";
import type { HostToolCall } from "../src/core/runtime/policy.js";
import type { AgentTool } from "../src/core/tools/types.js";
import { fixture, ScriptedModel, skills } from "./fixtures/runtime.js";

test("context usage reads the requested session's memory snapshot without changing another session", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const memoryPath = path.join(values.directory, "memory.md");
  await writeFile(memoryPath, "short memory");
  const model = new ScriptedModel();
  const runtime = await ThreadRuntime.open({ ...values, model, globalMemoryPath: memoryPath });
  try {
    const first = await runtime.createSession();
    const before = runtime.contextUsage(first.id)!;
    await writeFile(memoryPath, "long distinct memory ".repeat(2_000));
    const second = await runtime.createSession();
    assert.ok(runtime.contextUsage(second.id)!.requestTokens > before.requestTokens);
    assert.deepEqual(runtime.contextUsage(first.id), before);
    assert.equal(model.contexts.length, 0);
  } finally {
    await runtime.close();
  }
});

test("bare runtime executes literal prompts with only the supplied tool and system prompt", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const calls: string[] = [];
  const tool: AgentTool<{ value: string }> = {
    name: "echo",
    description: "Echo a value from the embedding host",
    parameters: Type.Object({ value: Type.String() }),
    replay: "safe",
    execution: { effect: "read", mode: "parallel", resources: () => [] },
    async execute({ value }) {
      calls.push(value);
      return { content: value, isError: false };
    },
  };
  const model = new ScriptedModel(async (_context, options, call) => {
    if (call === 1) {
      return fauxAssistantMessage([fauxToolCall("echo", { value: "custom tool" }, { id: "echo-1" })], {
        stopReason: "toolUse",
      });
    }
    options.onTextDelta?.("done");
    return fauxAssistantMessage(fauxText("done"));
  });
  const runtime = await ThreadRuntime.open({
    rootPath: values.rootPath,
    stateDirectory: values.stateDirectory,
    model,
    tools: [tool],
    systemPrompt: "Use only capabilities supplied by this host.",
    skills,
  });
  const events: RuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  try {
    const session = await runtime.createSession();
    const result = await runtime.prompt(session.id, "/new");
    assert.equal(result.outcome, "completed");
    assert.equal(result.turn.sessionId, session.id);
    assert.deepEqual(calls, ["custom tool"]);
    assert.equal(model.contexts[0]?.messages.at(-1)?.content, "/new");
    for (const context of model.contexts) {
      assert.equal(context.systemPrompt, "Use only capabilities supplied by this host.");
      assert.deepEqual(context.tools?.map((item) => item.name), ["echo"]);
    }
    const snapshot = runtime.readSession(session.id);
    assert.equal(snapshot.liveTipTurnId, result.turn.id);
    assert.equal(snapshot.turns.length, 1);
    assert.ok(snapshot.entries.some((entry) => entry.type === "tool_execution" && entry.toolName === "echo"));
    const turnEvents = events.filter((event) => event.turnId === result.turn.id);
    assert.ok(turnEvents.length > 0);
    assert.ok(turnEvents.every((event) => event.sessionId === session.id));
    const delta = turnEvents.find((event) => event.type === "assistant_text_delta");
    assert.equal(delta?.type, "assistant_text_delta");
    if (delta?.type === "assistant_text_delta") {
      assert.ok(snapshot.entries.some((entry) => entry.id === delta.entryId && entry.type === "message"));
    }
    const toolFinished = turnEvents.find((event) => event.type === "tool_finished");
    assert.equal(toolFinished?.type, "tool_finished");
    if (toolFinished?.type === "tool_finished") assert.equal(toolFinished.toolCallId, "echo-1");
    // Read results are detached: a client cannot rewrite the runtime's history.
    snapshot.turns[0]!.status = "running";
    assert.equal(runtime.readSession(session.id).turns[0]?.status, "completed");
  } finally {
    await runtime.close();
  }
  assert.equal(model.closes, 0);
});

test("explicit data directories isolate runtime state without changing process configuration", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const initialHome = process.env.THREAD_HOME;
  const first = await ThreadRuntime.open({
    rootPath: values.rootPath, stateDirectory: values.stateDirectory, model: new ScriptedModel(), skills,
  });
  let second: ThreadRuntime | undefined;
  try {
    second = await ThreadRuntime.open({
      rootPath: values.rootPath,
      stateDirectory: path.join(values.directory, "another-state"),
      model: new ScriptedModel(),
      skills,
    });
    const firstSession = await first.createSession();
    const secondSession = await second.createSession();
    assert.equal((await first.prompt(firstSession.id, "first host")).outcome, "completed");
    assert.equal((await second.prompt(secondSession.id, "second host")).outcome, "completed");
    assert.ok(!first.listSessions().some((item) => item.sessionId === secondSession.id));
    assert.ok(!second.listSessions().some((item) => item.sessionId === firstSession.id));
    assert.equal(process.env.THREAD_HOME, initialHome);
    assert.deepEqual(await readdir(values.rootPath), []);
    assert.ok((await readdir(values.stateDirectory)).length > 0);
  } finally {
    await second?.close();
    await first.close();
  }
});

test("prompt selects its explicit session and does not mix another client's history", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const model = new ScriptedModel();
  const runtime = await ThreadRuntime.open({
    rootPath: values.rootPath, stateDirectory: values.stateDirectory, model, skills,
  });
  try {
    const first = await runtime.createSession();
    const second = await runtime.createSession();
    const firstTurn = await runtime.prompt(first.id, "first session starts");
    const secondTurn = await runtime.prompt(second.id, "second session starts");
    const continued = await runtime.prompt(first.id, "first session continues");
    assert.equal(firstTurn.turn.sessionId, first.id);
    assert.equal(secondTurn.turn.sessionId, second.id);
    assert.equal(secondTurn.turn.parentTurnId, null);
    assert.equal(continued.turn.parentTurnId, firstTurn.turn.id);
    assert.deepEqual(model.contexts[1]?.messages.filter((message) => message.role === "user").map((message) => message.content), [
      "second session starts",
    ]);
    assert.deepEqual(model.contexts[2]?.messages.filter((message) => message.role === "user").map((message) => message.content), [
      "first session starts", "first session continues",
    ]);
    assert.equal(runtime.readSession(first.id).turns.length, 2);
    assert.equal(runtime.readSession(second.id).turns.length, 1);
    await assert.rejects(runtime.prompt("missing-session", "hello"), /session/i);
  } finally {
    await runtime.close();
  }
});

test("construction snapshots configuration used by both main and delegated execution", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const policyCalls: Array<Pick<HostToolCall, "agentId" | "toolName">> = [];
  let replacementPolicyCalls = 0;
  const worker = new ScriptedModel(async (_context, _options, call) => call === 1
    ? fauxAssistantMessage([fauxToolCall("read", { path: "host-private.txt" }, { id: "worker-read" })], { stopReason: "toolUse" })
    : fauxAssistantMessage(fauxText("The host denied access; finished without reading.")));
  const main = new ScriptedModel(async (context, _options, call) => {
    if (call === 1) {
      return fauxAssistantMessage([fauxToolCall("delegate_tasks", { tasks: [{
        title: "Inspect an input",
        objective: "Inspect the host-provided input if allowed",
        guidance: ["Respect the host policy."],
        acceptanceCriteria: ["Report the result."],
        writeScope: [{ path: "report.txt", kind: "file" }],
      }] }, { id: "delegate-one" })], { stopReason: "toolUse" });
    }
    if (call === 2) {
      const response = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "delegate-one");
      assert.equal(response?.role, "toolResult");
      if (response?.role !== "toolResult") throw new Error("Missing delegation response");
      assert.equal(response.isError, false);
      const payload = JSON.parse(response.content.filter((item) => item.type === "text").map((item) => item.text).join("")) as {
        tasks: Array<{ taskId: string }>;
      };
      return fauxAssistantMessage([fauxToolCall("wait_tasks", {
        taskIds: payload.tasks.map((task) => task.taskId), returnWhen: "all",
      }, { id: "wait-one" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText("Worker finished."));
  });
  const options: ThreadRuntimeOptions = {
    rootPath: values.rootPath,
    stateDirectory: values.stateDirectory,
    model: main,
    systemPrompt: "Original host instructions.",
    skills: { skills: [], diagnostics: [] },
    toolPolicy: (call) => {
      policyCalls.push({ agentId: call.agentId, toolName: call.toolName });
      return call.toolName === "read" ? { allow: false, reason: "Host input is private." } : { allow: true };
    },
    implementationWorker: {
      enabled: true,
      model: worker,
      settings: {
        thinkingLevel: "off",
        limits: { maxConcurrent: 1, maxSteps: 2, maxRuntimeMs: 10_000, maxRevisions: 1 },
      },
    },
  };
  const runtime = await ThreadRuntime.open(options);
  try {
    options.systemPrompt = "Changed behind the runtime's back.";
    options.toolPolicy = () => { replacementPolicyCalls++; return { allow: true }; };
    options.implementationWorker!.settings!.limits.maxSteps = 1;
    const session = await runtime.createSession();
    const result = await runtime.prompt(session.id, "Delegate the inspection", { maxSteps: 4, timeoutMs: 10_000 });
    assert.equal(result.outcome, "completed");
    assert.equal(replacementPolicyCalls, 0);
    assert.ok(policyCalls.some((call) => call.agentId === "main" && call.toolName === "delegate_tasks"));
    assert.ok(policyCalls.some((call) => call.agentId === "implementation-worker" && call.toolName === "read"));
    assert.ok(main.contexts.every((context) => context.systemPrompt?.startsWith("Original host instructions.")));
    assert.ok(main.contexts.every((context) => !context.systemPrompt?.includes("Changed behind")));
    assert.equal(worker.contexts.length, 2, "the captured two-step budget must still allow the final worker response");
    const denied = worker.contexts[1]?.messages.find((message) => message.role === "toolResult" && message.toolCallId === "worker-read");
    assert.equal(denied?.role, "toolResult");
    if (denied?.role === "toolResult") assert.equal(denied.isError, true);
    const tasks = runtime.readSession(session.id).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.summary.status, "completed");
  } finally {
    await runtime.close();
  }
});

test("runtime leaves existing memory files unused unless explicitly configured", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const memoryPath = path.join(values.stateDirectory, ".THREAD.md");
  const memory = "PRIVATE_MEMORY_MARKER: this must not enter this runtime.\n";
  await mkdir(values.stateDirectory);
  await writeFile(memoryPath, memory, "utf8");
  const model = new ScriptedModel();
  const runtime = await ThreadRuntime.open({
    rootPath: values.rootPath,
    stateDirectory: values.stateDirectory,
    model,
    tools: [],
    skills,
  });
  try {
    const session = await runtime.createSession();
    assert.equal((await runtime.prompt(session.id, "hello")).outcome, "completed");
    assert.equal(model.contexts.length, 1);
    const context = model.contexts[0]!;
    assert.ok(!context.systemPrompt?.includes("PRIVATE_MEMORY_MARKER"));
    assert.ok(!context.systemPrompt?.includes(memoryPath));
    assert.deepEqual(context.tools, []);
  } finally {
    await runtime.close();
  }
  assert.equal(await readFile(memoryPath, "utf8"), memory);
});
