import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
import { ThreadRuntime, type ThreadRuntimeOptions } from "../src/runtime/thread-runtime.js";
import type { RuntimeEvent } from "../src/runtime/events.js";
import { AskService, type AskQuestion, type AskRequest } from "../src/runtime/interaction.js";
import type { HostToolCall } from "../src/runtime/policy.js";
import type { AgentTool } from "../src/tools/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-runtime-"));
  const rootPath = path.join(directory, "project");
  const stateDirectory = path.join(directory, "state");
  await mkdir(rootPath);
  return {
    directory,
    rootPath,
    stateDirectory,
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

class ScriptedModel implements ModelClient {
  readonly modelId = "embedding-test";
  readonly providerId = "test";
  readonly contextWindow = 128_000;
  readonly maxOutputTokens = 8_192;
  readonly contexts: Context[] = [];
  closes = 0;

  constructor(private readonly respond: (
    context: Context,
    options: ModelRequestOptions,
    call: number,
  ) => Promise<AssistantMessage> = async () => fauxAssistantMessage(fauxText("ok"))) {}

  stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage> {
    this.contexts.push(structuredClone(context));
    return this.respond(context, options, this.contexts.length);
  }

  // An injected client can own additional resources; the host owns their lifetime.
  async close(): Promise<void> { this.closes++; }
}

const skills = { skills: [], diagnostics: [] };

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

test("close owns cancellation and waits for model cleanup before releasing persisted state", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const started = deferred();
  const aborted = deferred();
  const cleanup = deferred();
  const model = new ScriptedModel(async (_context, options) => {
    const abort = () => aborted.resolve();
    options.signal.addEventListener("abort", abort, { once: true });
    started.resolve();
    await aborted.promise;
    await cleanup.promise;
    options.signal.removeEventListener("abort", abort);
    options.signal.throwIfAborted();
    return fauxAssistantMessage(fauxText("unreachable"));
  });
  const runtime = await ThreadRuntime.open({
    rootPath: values.rootPath, stateDirectory: values.stateDirectory, model, skills,
  });
  let sessionId: string | undefined;
  try {
    sessionId = (await runtime.createSession()).id;
    const running = runtime.prompt(sessionId, "wait for cancellation");
    await Promise.race([started.promise, running.then(() => {
      throw new Error("Turn ended before the model started");
    })]);
    const closing = runtime.close();
    assert.equal(runtime.close(), closing);
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.race([aborted.promise, closing.then(() => {
      throw new Error("Runtime closed before requesting cancellation");
    })]);
    await Promise.resolve();
    assert.equal(closed, false, "close must wait for the model's cooperative cleanup");
    await assert.rejects(runtime.prompt(sessionId, "arrived during shutdown"), /clos/i);
    cleanup.resolve();
    assert.equal((await running).outcome, "interrupted");
    await closing;
    await assert.rejects(runtime.prompt(sessionId, "arrived after shutdown"), /clos/i);
    await assert.rejects(runtime.createSession(), /clos/i);
    assert.equal(model.closes, 0);
  } finally {
    cleanup.resolve();
    await runtime.close();
  }
  const reopened = await ThreadRuntime.open({
    rootPath: values.rootPath, stateDirectory: values.stateDirectory, model: new ScriptedModel(), skills,
  });
  try {
    const restored = reopened.readSession(sessionId!);
    assert.equal(restored.turns.length, 1);
    assert.equal(restored.turns[0]?.status, "interrupted");
  } finally {
    await reopened.close();
  }
});

test("interrupt waits for an active custom tool to settle and seals its history", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const started = deferred();
  const aborted = deferred();
  const cleanup = deferred();
  const tool: AgentTool = {
    name: "host_wait",
    description: "Wait until cancellation, then clean up",
    parameters: Type.Object({}),
    replay: "never",
    execution: { effect: "process", mode: "parallel", resources: () => [] },
    async execute(_args, context) {
      context.signal.addEventListener("abort", aborted.resolve, { once: true });
      started.resolve();
      await aborted.promise;
      await cleanup.promise;
      context.signal.throwIfAborted();
      return { content: "unreachable", isError: false };
    },
  };
  const model = new ScriptedModel(async (_context, _options, call) => call === 1
    ? fauxAssistantMessage([fauxToolCall("host_wait", {}, { id: "waiting-call" })], { stopReason: "toolUse" })
    : fauxAssistantMessage(fauxText("continued")));
  const runtime = await ThreadRuntime.open({
    rootPath: values.rootPath, stateDirectory: values.stateDirectory, model, tools: [tool], skills,
  });
  try {
    const session = await runtime.createSession();
    const other = await runtime.createSession();
    const running = runtime.prompt(session.id, "start the tool");
    await Promise.race([started.promise, running.then(() => {
      throw new Error("Turn ended before the waiting tool started");
    })]);
    await runtime.interrupt(other.id);
    const stopping = runtime.interrupt(session.id);
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.race([aborted.promise, stopping.then(() => {
      throw new Error("Interrupt returned before requesting tool cancellation");
    })]);
    await Promise.resolve();
    assert.equal(stopped, false);
    cleanup.resolve();
    await stopping;
    const interrupted = await running;
    assert.equal(interrupted.outcome, "interrupted");
    const continued = await runtime.prompt(session.id, "continue");
    assert.equal(continued.outcome, "completed");
    assert.equal(continued.turn.parentTurnId, interrupted.turn.id);
    const result = model.contexts[1]?.messages.find((message) =>
      message.role === "toolResult" && message.toolCallId === "waiting-call");
    assert.equal(result?.role, "toolResult");
    if (result?.role === "toolResult") assert.equal(result.isError, true);
  } finally {
    cleanup.resolve();
    await runtime.close();
  }
});

test("closing immediately after prompt cancels an unstarted request without failing shutdown", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const model = new ScriptedModel();
  const runtime = await ThreadRuntime.open({
    rootPath: values.rootPath, stateDirectory: values.stateDirectory, model, skills,
  });
  try {
    const session = await runtime.createSession();
    const running = runtime.prompt(session.id, "cancel before provider startup");
    const closing = runtime.close();
    await assert.rejects(running, { name: "AbortError" });
    await closing;
    assert.equal(runtime.close(), closing);
    assert.equal(model.contexts.length, 0);
  } finally {
    await runtime.close();
  }
});

test("interrupting immediately after prompt settles an unstarted request and keeps the runtime usable", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const model = new ScriptedModel();
  const runtime = await ThreadRuntime.open({
    rootPath: values.rootPath, stateDirectory: values.stateDirectory, model, skills,
  });
  try {
    const session = await runtime.createSession();
    const running = runtime.prompt(session.id, "cancel before model startup");
    const stopping = runtime.interrupt(session.id);
    await assert.rejects(running, { name: "AbortError" });
    await stopping;
    assert.equal(model.contexts.length, 0);
    assert.equal((await runtime.prompt(session.id, "continue after interruption")).outcome, "completed");
  } finally {
    await runtime.close();
  }
});

test("caller cancellation before model startup does not turn close into a shutdown failure", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const model = new ScriptedModel();
  const runtime = await ThreadRuntime.open({
    rootPath: values.rootPath, stateDirectory: values.stateDirectory, model, skills,
  });
  try {
    const session = await runtime.createSession();
    const controller = new AbortController();
    const reason = new Error("The host cancelled its pending request");
    const running = runtime.prompt(session.id, "cancel before model startup", { signal: controller.signal });
    controller.abort(reason);
    const closing = runtime.close();
    await assert.rejects(running, (error) => error === reason);
    await closing;
    assert.equal(model.contexts.length, 0);
  } finally {
    await runtime.close();
  }
});

test("subscribers cannot fail execution and unsubscribing does not cancel a turn", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const model = new ScriptedModel(async (_context, options) => {
    options.onTextDelta?.("answer");
    options.signal.throwIfAborted();
    return fauxAssistantMessage(fauxText("answer"));
  });
  const runtime = await ThreadRuntime.open({
    rootPath: values.rootPath, stateDirectory: values.stateDirectory, model, skills,
  });
  const types: string[] = [];
  const stopBrokenObserver = runtime.subscribe(() => { throw new Error("broken observer"); });
  const unsubscribe = runtime.subscribe((event) => types.push(event.type));
  try {
    const session = await runtime.createSession();
    const result = await runtime.prompt(session.id, "first");
    assert.equal(result.outcome, "completed");
    assert.ok(types.includes("assistant_text_delta"));
    assert.ok(types.includes("turn_finished"));
    const count = types.length;
    unsubscribe();
    unsubscribe();
    stopBrokenObserver();
    let lastObserverReceivedText = false;
    const stopLastObserver = runtime.subscribe((event) => {
      if (event.type !== "assistant_text_delta") return;
      lastObserverReceivedText = true;
      stopLastObserver();
    });
    assert.equal((await runtime.prompt(session.id, "second")).outcome, "completed");
    assert.equal(lastObserverReceivedText, true);
    assert.equal(types.length, count);
    assert.equal(runtime.readSession(session.id).turns.length, 2);
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

test("closing a parked question cancels the turn and preserves the host's AskService", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const parked = deferred();
  const questions: AskQuestion[] = [{
    question: "Which output should the host use?",
    header: "Output",
    options: [
      { label: "Text", description: "Return a text answer." },
      { label: "JSON", description: "Return structured data." },
    ],
  }];
  const ask = new class extends AskService {
    disposals = 0;
    override dispose(): void { this.disposals++; super.dispose(); }
  }();
  let request: AskRequest | undefined;
  const unsubscribe = ask.subscribe((value) => {
    if (value) { request = value; parked.resolve(); }
  });
  const model = new ScriptedModel(async () => fauxAssistantMessage([
    fauxToolCall("ask", { questions }, { id: "ask-output" }),
  ], { stopReason: "toolUse" }));
  const runtime = await ThreadRuntime.open({
    rootPath: values.rootPath, stateDirectory: values.stateDirectory, model, skills, askPresenter: ask,
  });
  let startedTurnId: string | undefined;
  runtime.subscribe((event) => {
    if (event.type === "turn_started") startedTurnId = event.turnId;
  });
  try {
    const session = await runtime.createSession();
    const running = runtime.prompt(session.id, "Choose an output format");
    await Promise.race([parked.promise, running.then(() => {
      throw new Error("Turn ended before asking the host");
    })]);
    assert.ok(startedTurnId);
    assert.ok(request?.id);
    assert.deepEqual(request?.invocation, {
      sessionId: session.id, turnId: startedTurnId, toolCallId: "ask-output", agentId: "main",
    });
    const closing = runtime.close();
    assert.equal((await running).outcome, "interrupted");
    await closing;
    assert.equal(ask.current, undefined);
    assert.equal(ask.disposals, 0);
    // The same host-owned interaction service remains usable by another client.
    const manual = { id: "host-question", questions };
    const answer = ask.present(manual, new AbortController().signal);
    ask.reply(manual.id, [["Text"]]);
    assert.deepEqual(await answer, [["Text"]]);
  } finally {
    await runtime.close();
    unsubscribe();
    ask.dispose();
  }
});
