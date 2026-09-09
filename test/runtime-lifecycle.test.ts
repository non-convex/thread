import assert from "node:assert/strict";
import test from "node:test";
import { Type, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ThreadRuntime } from "../src/core/runtime/thread-runtime.js";
import { AskService, type AskQuestion, type AskRequest } from "../src/core/runtime/interaction.js";
import type { AgentTool } from "../src/core/tools/types.js";
import { deferred, fixture, ScriptedModel, skills } from "./fixtures/runtime.js";

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
