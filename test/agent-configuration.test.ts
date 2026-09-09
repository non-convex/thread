import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spyOn } from "bun:test";
import * as git from "../src/ui/terminal/git.js";
import {
  fauxAssistantMessage,
  fauxText,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import type {
  ModelCatalog,
  ModelClient,
  ModelDescriptor,
  ModelRequestOptions,
} from "../src/core/agent/model-client.js";
import { ThreadApp } from "../src/app/thread-app.js";
import { DEFAULT_COMMIT_ATTRIBUTION, formatCommitAttributionPrompt } from "../src/app/system-prompt.js";
import { GLOBAL_MEMORY_FILE } from "../src/core/global-memory.js";
import { loadThreadConfig } from "../src/app/config/thread-config.js";
import { loadThreadState, saveThreadState } from "../src/app/config/thread-state.js";
import { type ThreadState } from "../src/core/runtime/state.js";
import { primarySlashSuggestions, ThreadTuiController } from "../src/ui/terminal/controller.js";
import { filteredModels, isFloatingOverlay, type UiScreen } from "../src/ui/state.js";

class TestModel implements ModelClient {
  readonly providerId = "test";
  readonly contextWindow = 32_000;
  readonly maxOutputTokens = 4_096;
  readonly reasoning = false;
  readonly contexts: Context[] = [];

  constructor(readonly modelId: string) {}

  async stream(_context: Context, _options: ModelRequestOptions): Promise<AssistantMessage> {
    this.contexts.push(structuredClone(_context));
    return fauxAssistantMessage(fauxText("ok"));
  }
}

class TestCatalog implements ModelCatalog {
  private readonly descriptors: ModelDescriptor[] = ["main", "main-2", "worker", "dreamer"].map((modelId) => ({
    providerId: "test",
    modelId,
    name: modelId,
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    reasoning: false,
  }));

  list(providerId?: string): ModelDescriptor[] {
    return providerId && providerId !== "test" ? [] : [...this.descriptors];
  }

  listAll(providerId?: string): ModelDescriptor[] {
    return this.list(providerId);
  }

  createClient(providerId: string, modelId: string): ModelClient {
    if (providerId !== "test" || !this.descriptors.some((item) => item.modelId === modelId)) {
      throw new Error(`Unknown model: ${providerId}/${modelId}`);
    }
    return new TestModel(modelId);
  }
}

async function directory(prefix: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const value = await mkdtemp(path.join(tmpdir(), prefix));
  return {
    path: value,
    cleanup: () => rm(value, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

test("Dreamer config requires an explicit model and defaults thinking to high", async (t) => {
  const values = await directory("thread-agent-config-");
  t.after(values.cleanup);
  const validPath = path.join(values.path, "valid.json");
  await writeFile(validPath, JSON.stringify({
    attribution: { commit: "" },
    agents: {
      dreamer: { model: { provider: "test", id: "dreamer" } },
    },
  }), "utf8");
  const loaded = await loadThreadConfig(validPath);
  assert.deepEqual(loaded?.config.agents.dreamer, {
    model: { provider: "test", id: "dreamer" },
    thinkingLevel: "high",
  });
  assert.equal(loaded?.config.attribution?.commit, "");

  const invalidPath = path.join(values.path, "invalid.json");
  await writeFile(invalidPath, JSON.stringify({ agents: { dreamer: {} } }), "utf8");
  const invalid = await loadThreadConfig(invalidPath);
  assert.equal(invalid?.config.agents.dreamer, undefined);
  assert.match(invalid?.agentDiagnostics[0] ?? "", /agents\.dreamer\.model must be an object/);
});

test("old state remains readable and Dreamer enablement persists without changing its shape", async (t) => {
  const values = await directory("thread-agent-state-");
  t.after(values.cleanup);
  const statePath = path.join(values.path, "state.json");
  await writeFile(statePath, JSON.stringify({
    model: { provider: "test", id: "main" },
    agents: {
      "implementation-worker": {
        enabled: true,
        model: { provider: "test", id: "worker" },
      },
    },
  }), "utf8");
  const oldState = await loadThreadState(statePath);
  assert.equal(oldState?.agents?.dreamer, undefined);
  assert.equal(oldState?.agents?.["implementation-worker"]?.enabled, true);

  const next: ThreadState = {
    ...oldState,
    agents: {
      ...oldState?.agents,
      dreamer: { enabled: true, model: { provider: "test", id: "dreamer" } },
    },
  };
  await saveThreadState(next, statePath);
  assert.deepEqual(await loadThreadState(statePath), next);
});

test("/model selects the main model and /agent configures secondary agents", async (t) => {
  const values = await directory("thread-agent-command-");
  t.after(values.cleanup);
  const root = path.join(values.path, "project");
  const home = path.join(values.path, "home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  const previous = process.env.THREAD_HOME;
  process.env.THREAD_HOME = home;
  const states: ThreadState[] = [];
  const catalog = new TestCatalog();
  const app = await ThreadApp.open({
    rootPath: root,
    model: catalog.createClient("test", "main"),
    modelCatalog: catalog,
    systemPrompt: formatCommitAttributionPrompt(DEFAULT_COMMIT_ATTRIBUTION),
    globalMemoryPath: path.join(home, GLOBAL_MEMORY_FILE),
    skills: { skills: [], diagnostics: [] },
    onStateChange: (state) => states.push(state),
  });
  try {
    const suggestions = primarySlashSuggestions(false);
    assert.ok(suggestions.some((item) => item.name === "agent"));
    assert.ok(suggestions.some((item) => item.name === "model"));
    assert.ok(!suggestions.some((item) => item.name === "subagent"));

    await app.handleInput("Check product instructions", { signal: new AbortController().signal });
    assert.match((app.runtime.model as TestModel).contexts[0]!.systemPrompt!, /Co-authored-by: Thread/);
    const overview = await app.handleInput("/agent", { signal: new AbortController().signal });
    assert.equal(overview.kind, "command");
    assert.match(overview.result.content, /main: on/);
    assert.match(overview.result.content, /implementation-worker: off/);
    assert.match(overview.result.content, /dreamer: off/);
    assert.equal(overview.result.view?.type, "agent_picker");
    if (overview.result.view?.type === "agent_picker") {
      assert.deepEqual(overview.result.view.agents.map((agent) => agent.id), [
        "main",
        "implementation-worker",
        "dreamer",
      ]);
    }

    await app.handleInput("/agent implementation-worker model test/worker", { signal: new AbortController().signal });
    await app.handleInput("/agent dreamer model test/dreamer", { signal: new AbortController().signal });
    assert.equal(app.runtime.subagentEnabled, true);
    assert.equal(app.runtime.dreamerEnabled, true);
    assert.equal(states.at(-1)?.agents?.dreamer?.enabled, true);

    await app.handleInput("/agent implementation-worker off", { signal: new AbortController().signal });
    assert.equal(app.runtime.subagentEnabled, false);
    await assert.rejects(
      app.handleInput("/subagent off", { signal: new AbortController().signal }),
      /Unknown command: \/subagent/,
    );
    await assert.rejects(
      app.handleInput("/foo", { signal: new AbortController().signal }),
      /Unknown command: \/foo/,
    );
    await app.handleInput("/model test/main-2", { signal: new AbortController().signal });
    assert.equal(app.runtime.model?.modelId, "main-2");
    await app.handleInput("Use selected model", { signal: new AbortController().signal });
    assert.equal((app.runtime.model as TestModel).contexts.length, 1);

    await app.handleInput("/agent dreamer off", { signal: new AbortController().signal });
    assert.equal(app.runtime.dreamerEnabled, false);
    assert.equal(states.at(-1)?.agents?.dreamer?.enabled, false);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.THREAD_HOME;
    else process.env.THREAD_HOME = previous;
  }
});

test("TUI command menus preserve navigation, prefill arguments, and allow failed choices to be retried", async (t) => {
  const values = await directory("thread-command-menu-");
  t.after(values.cleanup);
  // Menu navigation does not need background Git processes holding the temporary cwd.
  const gitProbe = spyOn(git, "gitBranchName").mockResolvedValue(undefined);
  t.after(() => gitProbe.mockRestore());
  const previous = process.env.THREAD_HOME;
  process.env.THREAD_HOME = path.join(values.path, "home");
  const catalog = new TestCatalog();
  const app = await ThreadApp.open({
    rootPath: values.path,
    globalMemoryPath: path.join(values.path, "home", GLOBAL_MEMORY_FILE),
    search: { semantic: false },
    model: catalog.createClient("test", "main"),
    modelCatalog: catalog,
    skills: { skills: [{
      name: "review", description: "Review the current changes", content: "Review only.",
      filePath: path.join(values.path, "SKILL.md"), baseDir: values.path, disableModelInvocation: true,
    }], diagnostics: [] },
  });
  const tui = new ThreadTuiController(app);
  const screen = <T extends UiScreen["type"]>(type: T): Extract<UiScreen, { type: T }> => {
    assert.equal(tui.state.screen.type, type);
    return tui.state.screen as Extract<UiScreen, { type: T }>;
  };
  const enter = async () => {
    tui.handleScreenKey({ name: "return", ctrl: false, shift: false, meta: false });
    const deadline = Date.now() + 3_000;
    while (tui.isActive || (isFloatingOverlay(tui.state.screen) && tui.state.screen.busy)) {
      assert.ok(Date.now() < deadline, "menu command did not finish");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  };
  try {
    const unregister = app.commands.register({
      name: "extension", description: "Extension command",
      async execute() { return { content: "extension result", presentation: "ephemeral", changedState: false }; },
    });
    await tui.submit("/thread");
    const menu = screen("command_picker");
    assert.ok(menu.items.some((item) => item.label === "extension"));
    menu.selected = menu.items.findIndex((item) => item.label === "status");
    await enter();
    assert.match(screen("document").content, /active session:/);
    tui.closeView();
    assert.equal(screen("command_picker"), menu);
    assert.equal(menu.items[menu.selected]!.label, "status");
    menu.selected = menu.items.findIndex((item) => item.label === "search");
    await enter();
    screen("session");
    assert.equal(tui.state.composerInput, "/thread search ");
    delete tui.state.composerInput; // The mounted composer consumes this request.
    unregister();

    await tui.submit("/skill");
    assert.equal(screen("command_picker").items[0]!.label, "review");
    await enter();
    assert.equal(tui.state.composerInput, "/skill review ");
    assert.equal(app.runtime["tree"].projection.turns.size, 0);
    delete tui.state.composerInput;

    await tui.submit("/agent");
    const agents = screen("agent_picker");
    agents.selected = 1;
    await enter();
    const settings = screen("agent_settings");
    settings.selected = 2; // Explicit model selection, independent of On/Off.
    await enter();
    for (const character of "worker") {
      tui.handleScreenKey({ name: character, sequence: character, ctrl: false, shift: false, meta: false });
    }
    const picker = screen("model_picker");
    assert.deepEqual(filteredModels(picker).map((model) => model.modelId), ["worker"]);
    picker.selected = filteredModels(picker).length; // Browse all models.
    await enter();
    assert.equal(screen("model_picker").scope, "all");
    assert.equal(screen("model_picker").filter, "worker");
    tui.closeView();
    assert.equal(screen("agent_settings"), settings);
    assert.equal(settings.selected, 2);
    tui.closeView();
    assert.equal(screen("agent_picker"), agents);
    assert.equal(agents.selected, 1);
    tui.closeView();
    screen("session");

    const listed = await app.handleInput("/agent implementation-worker model list test", { signal: new AbortController().signal });
    assert.equal(listed.kind, "command");
    if (listed.kind !== "command") throw new Error("Expected model list");
    assert.match(listed.result.content, /test\/worker/); // Plain mode keeps its list.
    assert.equal(listed.result.view?.type, "model_picker");
    await tui.submit("/model list test");
    const mainPicker = screen("model_picker");
    assert.equal(mainPicker.filter, "test/");
    mainPicker.models.push({ ...mainPicker.models[0]!, providerId: "other-test" });
    assert.ok(filteredModels(mainPicker).every((model) => model.providerId === "test"));
    mainPicker.models.unshift({ ...mainPicker.models[0]!, modelId: "missing" });
    mainPicker.selected = 0;
    await enter();
    assert.equal(screen("model_picker"), mainPicker);
    assert.match(mainPicker.error ?? "", /Unknown model/);
    assert.equal(mainPicker.busy, false);
    mainPicker.selected = 1;
    await enter();
    screen("session");

    const firstSession = app.selectedSessionId;
    const turn = await app.runtime["tree"].startTurn("Find this request in the Session picker");
    await app.runtime["tree"].finishTurn(turn.id, "completed");
    await tui.submit("/new");
    for (const command of ["/session", "/thread sessions", "/thread open"]) {
      await tui.submit(command);
      const sessions = screen("command_picker");
      assert.equal(sessions.items.length, 2);
      assert.ok(sessions.items.some((item) => item.current));
      sessions.selected = sessions.items.findIndex((item) => item.command === `/session ${firstSession}`);
      assert.match(sessions.items[sessions.selected]!.label, /Find this request/);
    }
    await enter();
    assert.equal(app.selectedSessionId, firstSession);
    screen("session");

    await tui.submit("/rewind");
    const rewind = screen("rewind");
    rewind.items[0]!.turnId = "missing";
    await enter();
    await enter();
    assert.equal(screen("rewind"), rewind);
    assert.ok(rewind.error);
    assert.equal(rewind.confirm, false);
    rewind.items[0]!.turnId = turn.id;
    await enter();
    await enter();
    screen("session");
    assert.equal(app.runtime["tree"].activeLiveTip, null);
  } finally {
    tui.dispose();
    await app.close();
    if (previous === undefined) delete process.env.THREAD_HOME;
    else process.env.THREAD_HOME = previous;
  }
});
