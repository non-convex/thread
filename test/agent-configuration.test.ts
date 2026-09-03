import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
} from "../src/agent/model-client.js";
import { ThreadApp } from "../src/app.js";
import { loadThreadConfig } from "../src/config/thread-config.js";
import { loadThreadState, saveThreadState, type ThreadState } from "../src/config/thread-state.js";
import { primarySlashSuggestions } from "../src/ui/terminal/controller.js";

class TestModel implements ModelClient {
  readonly providerId = "test";
  readonly contextWindow = 32_000;
  readonly maxOutputTokens = 4_096;
  readonly reasoning = false;

  constructor(readonly modelId: string) {}

  async stream(_context: Context, _options: ModelRequestOptions): Promise<AssistantMessage> {
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

test("Dreamer config requires an explicit model and defaults thinking to low", async (t) => {
  const values = await directory("thread-agent-config-");
  t.after(values.cleanup);
  const validPath = path.join(values.path, "valid.json");
  await writeFile(validPath, JSON.stringify({
    agents: {
      dreamer: { model: { provider: "test", id: "dreamer" } },
    },
  }), "utf8");
  const loaded = await loadThreadConfig(validPath);
  assert.deepEqual(loaded?.config.agents.dreamer, {
    model: { provider: "test", id: "dreamer" },
    thinkingLevel: "low",
  });

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

test("/agent is the common model entry point and old commands remain aliases", async (t) => {
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
    skills: { skills: [], diagnostics: [] },
    onStateChange: (state) => states.push(state),
  });
  try {
    const suggestions = primarySlashSuggestions(false);
    assert.ok(suggestions.some((item) => item.name === "agent"));
    assert.ok(!suggestions.some((item) => item.name === "model" || item.name === "subagent"));

    assert.deepEqual(app.agentProfiles.list().map((profile) => profile.id), ["main"]);
    const overview = await app.handleInput("/agent", { signal: new AbortController().signal });
    assert.equal(overview.kind, "command");
    assert.match(overview.result.content, /main: on/);
    assert.match(overview.result.content, /implementation-worker: off/);
    assert.match(overview.result.content, /dreamer: off/);

    await app.handleInput("/agent implementation-worker model test/worker", { signal: new AbortController().signal });
    await app.handleInput("/agent dreamer model test/dreamer", { signal: new AbortController().signal });
    assert.equal(app.subagentEnabled, true);
    assert.equal(app.dreamerEnabled, true);
    assert.deepEqual(app.agentProfiles.list().map((profile) => profile.id).sort(), [
      "dreamer",
      "implementation-worker",
      "main",
    ]);
    assert.equal(states.at(-1)?.agents?.dreamer?.enabled, true);

    await app.handleInput("/subagent off", { signal: new AbortController().signal });
    assert.equal(app.subagentEnabled, false);
    await app.handleInput("/model test/main-2", { signal: new AbortController().signal });
    assert.equal(app.model?.modelId, "main-2");
    assert.equal(app.agentProfiles.get("main")?.model.modelId, "main-2");

    await app.handleInput("/agent dreamer off", { signal: new AbortController().signal });
    assert.equal(app.dreamerEnabled, false);
    assert.equal(states.at(-1)?.agents?.dreamer?.enabled, false);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.THREAD_HOME;
    else process.env.THREAD_HOME = previous;
  }
});
