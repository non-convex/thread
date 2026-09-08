import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spyOn } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelClient } from "../src/agent/model-client.js";
import { ThreadApp, type ThreadAppOptions } from "../src/app/thread-app.js";
import { ThreadTuiController } from "../src/ui/terminal/controller.js";
import type { TerminalKey } from "../src/ui/terminal/view-model.js";
import * as git from "../src/utils/git.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function fixture(stream: ModelClient["stream"], options: Pick<ThreadAppOptions, "skills"> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-runtime-ui-"));
  const rootPath = path.join(directory, "project");
  await mkdir(rootPath);
  const app = await ThreadApp.open({
    rootPath, stateDirectory: path.join(directory, "state"), tools: [], search: false, globalMemoryPath: false, skills: { paths: [] },
    ...options,
    model: { providerId: "test", modelId: "runtime-ui", contextWindow: 128_000, maxOutputTokens: 8_192, reasoning: true, stream },
  });
  return { app, cleanup: async () => { await app.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } };
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "UI did not receive runtime events");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("TUI questions settle through answers, dismissal, interruption and disposal", async (t) => {
  const gitProbe = spyOn(git, "gitBranchName").mockResolvedValue(undefined);
  t.after(() => gitProbe.mockRestore());
  const results: string[] = [];
  const questions = ["Format", "Destination"].map((header) => ({
    header, question: `Choose ${header}`, options: [
      { label: "Text", description: "Plain text" }, { label: "JSON", description: "Structured data" },
    ],
  }));
  const values = await fixture(async (context) => {
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") {
      results.push(JSON.stringify(last));
      return fauxAssistantMessage(fauxText("done"));
    }
    return fauxAssistantMessage(fauxToolCall("ask", { questions }), { stopReason: "toolUse" });
  });
  const tui = new ThreadTuiController(values.app);
  t.after(async () => { tui.dispose(); await values.cleanup(); });
  const key = (name: string, sequence?: string): TerminalKey => ({ name, ctrl: false, shift: false, meta: false, ...(sequence ? { sequence } : {}) });
  const answering = tui.submit("ask");
  await waitFor(() => tui.state.screen.type === "ask");
  tui.handleScreenKey(key("return"));
  assert.equal(tui.state.screen.type === "ask" && tui.state.screen.questionIndex, 1);
  for (const char of "custom") tui.handleScreenKey(key(char, char));
  tui.handleScreenKey(key("return"));
  await answering;
  assert.match(results[0]!, /Text/);
  assert.match(results[0]!, /custom/);

  const dismissed = tui.submit("ask again");
  await waitFor(() => tui.state.screen.type === "ask");
  tui.closeView();
  await dismissed;
  assert.match(results[1]!, /dismissed/);
  assert.equal(tui.state.screen.type, "session");

  const interrupted = tui.submit("interrupt this question");
  await waitFor(() => tui.state.screen.type === "ask");
  assert.equal(tui.interrupt(), true);
  await interrupted;
  assert.equal(tui.state.screen.type, "session");

  const disposed = tui.submit("dispose this question");
  await waitFor(() => tui.state.screen.type === "ask");
  tui.dispose();
  await disposed;
  assert.equal(values.app.runtime.readSession(values.app.selectedSessionId).turns.at(-1)?.status, "interrupted");
});

test("Skill menus show declared path snapshots and neutral guidance when no paths are configured", async () => {
  for (const configured of [undefined, { skills: [], diagnostics: [] }, { paths: ["./application-skills", "../shared-skills"] }]) {
    const values = await fixture(async () => fauxAssistantMessage(fauxText("ok")), configured ? { skills: configured } : {});
    try {
      const expectedPaths = configured && "paths" in configured
        ? configured.paths.map((directory) => path.resolve(values.app.runtime.rootPath, directory)) : [];
      if (configured && "paths" in configured) configured.paths.splice(0, configured.paths.length, "./changed-after-open");
      const response = await values.app.handleInput("/skill", { signal: new AbortController().signal });
      assert.equal(response.kind, "command");
      if (response.kind !== "command") throw new Error("Expected Skill menu");
      assert.equal(response.result.view?.type, "command_picker");
      if (response.result.view?.type !== "command_picker") throw new Error("Expected Skill picker");
      assert.deepEqual(response.result.view.items, []);
      for (const directory of expectedPaths) {
        assert.ok(response.result.content.includes(directory));
        assert.ok(response.result.view.emptyText?.includes(directory));
      }
      if (!expectedPaths.length) {
        assert.equal(response.result.view.emptyText, "No skills loaded for this application.");
        assert.doesNotMatch(response.result.content, /Skills directory:/);
      }
      assert.doesNotMatch(JSON.stringify(response.result), /runtime options|changed-after-open/);
    } finally { await values.cleanup(); }
  }
});

test("TUI consumes runtime subscriptions through public snapshots without duplicate stream delivery", async (t) => {
  const gitProbe = spyOn(git, "gitBranchName").mockResolvedValue(undefined);
  t.after(() => gitProbe.mockRestore());
  const release = [gate(), gate()];
  let requests = 0;
  let externalSignal: AbortSignal | undefined;
  const values = await fixture(async (_context, options) => {
    const index = requests++;
    if (index === 0) externalSignal = options.signal;
    options.onTextDelta?.("hello");
    await release[index]!.promise;
    return fauxAssistantMessage(fauxText("hello"));
  });
  assert.equal("sessionTree" in values.app, false);
  assert.equal("prompt" in values.app, false, "application must not duplicate the runtime API");
  const tui = new ThreadTuiController(values.app);
  t.after(async () => { release.forEach((item) => item.resolve()); tui.dispose(); await values.cleanup(); });

  // This turn bypasses handleInput and therefore has no per-input UI callback.
  const external = values.app.runtime.prompt(values.app.selectedSessionId, "external");
  await waitFor(() => tui.state.liveTurn?.blocks.some((block) => block.content === "hello") === true);
  assert.equal(tui.state.liveTurn?.blocks.filter((block) => block.kind === "assistant").length, 1);
  assert.equal(tui.interrupt(), true);
  assert.equal(externalSignal?.aborted, true);
  release[0]!.resolve();
  assert.equal((await external).outcome, "interrupted");
  await waitFor(() => tui.state.liveTurn === undefined && tui.state.transcript.some((item) => item.content === "hello"));
  assert.equal(tui.state.busy, false);

  const submitted = tui.submit("from composer");
  await waitFor(() => tui.state.liveTurn?.blocks.some((block) => block.content === "hello") === true);
  assert.equal(tui.state.liveTurn?.blocks.find((block) => block.kind === "assistant")?.content, "hello");
  assert.doesNotThrow(() => tui.cycleThinkingLevel());
  release[1]!.resolve();
  await submitted;
  assert.equal(tui.state.transcript.filter((item) => item.kind === "assistant" && item.content === "hello").length, 2);
});

test("stopping during a turn detaches observations and never refreshes UI after close begins", async (t) => {
  const gitProbe = spyOn(git, "gitBranchName").mockResolvedValue(undefined);
  t.after(() => gitProbe.mockRestore());
  const started = gate();
  const cancelled = gate();
  const release = gate();
  const values = await fixture(async (_context, options) => {
    options.onTextDelta?.("working");
    started.resolve();
    if (!options.signal.aborted) await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    cancelled.resolve();
    await release.promise;
    return fauxAssistantMessage(fauxText("stopped"), { stopReason: "aborted" });
  });
  const tui = new ThreadTuiController(values.app);
  t.after(async () => { release.resolve(); tui.dispose(); await values.cleanup(); });
  const running = tui.submit("long task");
  await started.promise;
  await waitFor(() => tui.state.liveTurn !== undefined);
  let readsAfterStop = 0;
  const readSession = values.app.runtime.readSession.bind(values.app.runtime);
  values.app.runtime.readSession = (id) => {
    if (tui.isStopped) readsAfterStop++;
    return readSession(id);
  };
  tui.requestStop();
  const snapshot = structuredClone(tui.state);
  const closing = values.app.close();
  await cancelled.promise;
  release.resolve();
  await Promise.all([running, closing]);
  assert.equal(readsAfterStop, 0);
  assert.deepEqual(tui.state, snapshot);
  assert.doesNotThrow(() => tui.cycleThinkingLevel());
  tui.dispose();
  tui.dispose();
});

test("changing thinking while running preserves this turn and applies to the next one", async (t) => {
  const gitProbe = spyOn(git, "gitBranchName").mockResolvedValue(undefined);
  t.after(() => gitProbe.mockRestore());
  const started = gate();
  const release = gate();
  const reasoning: Array<ThinkingLevel | undefined> = [];
  const values = await fixture(async (_context, options) => {
    reasoning.push(options.reasoning);
    if (reasoning.length === 1) {
      started.resolve();
      await release.promise;
      return fauxAssistantMessage(fauxToolCall("missing", {}), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText("done"));
  });
  const tui = new ThreadTuiController(values.app);
  t.after(async () => { release.resolve(); tui.dispose(); await values.cleanup(); });
  const running = tui.submit("first turn");
  await started.promise;
  assert.equal(values.app.runtime.thinkingLevel, "medium");
  tui.cycleThinkingLevel();
  assert.equal(values.app.runtime.thinkingLevel, "high");
  assert.equal(tui.meta.thinkingLevel, "high");
  release.resolve();
  await running;
  await tui.submit("next turn");
  assert.deepEqual(reasoning, ["medium", "medium", "high"]);
});

test("coding input errors retain actionable model and skill guidance", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-input-guidance-"));
  const app = await ThreadApp.open({ rootPath: directory, stateDirectory: path.join(directory, "state"),
    search: false, globalMemoryPath: false, skills: { paths: [] } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const options = { signal: new AbortController().signal };
  await assert.rejects(app.handleInput("hello", options), /No model configured\. Use \/model list and \/model <provider>\/<model>\./);
  await assert.rejects(app.handleInput("/compact", options), /\/compact requires a configured model/);
  await assert.rejects(app.handleInput("/skill test", options), /\/skill requires a configured model/);
});

test("the coding ask tool uses the TUI panel and resumes with the chosen answer", async (t) => {
  const gitProbe = spyOn(git, "gitBranchName").mockResolvedValue(undefined);
  t.after(() => gitProbe.mockRestore());
  let calls = 0;
  let answer = "";
  const values = await fixture(async (context) => {
    if (++calls === 1) return fauxAssistantMessage(fauxToolCall("ask", { questions: [{
      question: "Choose an output", header: "Output", options: [
        { label: "Text", description: "Use text." }, { label: "JSON", description: "Use JSON." },
      ],
    }] }), { stopReason: "toolUse" });
    answer = JSON.stringify(context.messages.at(-1));
    return fauxAssistantMessage(fauxText("answered"));
  });
  const tui = new ThreadTuiController(values.app);
  t.after(async () => { tui.dispose(); await values.cleanup(); });
  const running = tui.submit("ask me");
  await waitFor(() => tui.state.screen.type === "ask");
  assert.equal(tui.handleScreenKey({ name: "down", preventDefault() {} }), true);
  assert.equal(tui.handleScreenKey({ name: "return", preventDefault() {} }), true);
  await running;
  assert.equal(tui.state.screen.type, "session");
  assert.match(answer, /JSON/);
  assert.doesNotMatch(answer, /No interactive user/);
  assert.equal(values.app.runtime.readSession(values.app.selectedSessionId).turns[0]?.status, "completed");
});
