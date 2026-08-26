import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { ThreadApp, type InputResult } from "../../src/app.js";
import { createConfiguredModelCatalog, DEFAULT_MODEL_MAX_RETRIES, PiModelCatalog, PiModelClient } from "../../src/agent/model-client.js";
import { loadModelConfig } from "../../src/config/model-config.js";
import { createUiState, moveSelection, openEphemeralView } from "../../src/ui/state.js";
import { ThreadTuiController } from "../../src/ui/terminal/controller.js";
import { commitAll, initRepository } from "../helpers/git-fixture.js";

function commandContent(result: InputResult): string {
  assert.equal(result.kind, "command");
  return result.kind === "command" ? result.result.content : "";
}

test("forkComplete preserves tool definitions but rejects tool calls without executing them", async () => {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "secret.txt" }), { stopReason: "toolUse" }),
  ]);
  const client = new PiModelClient(models, faux.getModel());
  const context: Context = {
    systemPrompt: "system",
    messages: [{ role: "user", content: "summarize", timestamp: 1 }],
    tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }],
  };
  await assert.rejects(
    client.forkComplete(context, "Do not call tools", { signal: new AbortController().signal }),
    /read-only and tools were not executed/,
  );
  assert.equal(context.tools?.length, 1, "the caller's exact tool prefix remains intact");
});

test("PiModelClient retries transient model errors ten times and reports each attempt", async () => {
  assert.equal(DEFAULT_MODEL_MAX_RETRIES, 10);
  const faux = fauxProvider();
  let streamCalls = 0;
  const fakeModels = {
    streamSimple() {
      streamCalls++;
      return {
        async *[Symbol.asyncIterator]() {},
        async result() {
          return {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "overloaded",
            timestamp: Date.now(),
          };
        },
      };
    },
  };
  const client = new PiModelClient(fakeModels as never, faux.getModel());
  const scheduled: number[] = [];
  const started: number[] = [];
  const context: Context = { systemPrompt: "", messages: [], tools: [] };
  const message = await client.stream(context, {
    signal: new AbortController().signal,
    maxRetries: 10,
    retryBaseDelayMs: 1,
    onRetryScheduled: (attempt) => { scheduled.push(attempt); },
    onRetryAttemptStart: (attempt) => { started.push(attempt); },
  });
  assert.equal(message.stopReason, "error");
  assert.equal(streamCalls, 11, "one initial attempt plus ten retries");
  assert.deepEqual(scheduled, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(started, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("configured model catalogs hide built-ins from the default list", () => {
  const catalog = createConfiguredModelCatalog({
    configured: {
      name: "Configured",
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKeyEnv: "THREAD_TEST_API_KEY",
      models: [{
        id: "configured-model",
        name: "Configured Model",
        reasoning: false,
        input: ["text"],
        contextWindow: 8_000,
        maxTokens: 2_000,
      }],
    },
  });

  assert.deepEqual(
    catalog.list().map((model) => `${model.providerId}/${model.modelId}`),
    ["configured/configured-model"],
  );
  assert.ok(catalog.listAll().length > catalog.list().length);
});

test("thread model config preserves the default and per-model thinking levels", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-thinking-config-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const configPath = path.join(fixture, "config.json");
  await writeFile(configPath, JSON.stringify({
    model: { provider: "relay", id: "reasoner" },
    defaultThinkingLevel: "high",
    providers: {
      relay: {
        name: "Relay",
        api: "openai-responses",
        baseUrl: "https://example.test/v1",
        apiKeyEnv: "THREAD_TEST_API_KEY",
        models: [{
          id: "reasoner",
          reasoning: true,
          contextWindow: 16_000,
          maxTokens: 4_000,
          thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
        }],
      },
    },
  }));

  const loaded = await loadModelConfig(configPath);
  assert.equal(loaded?.config.defaultThinkingLevel, "high");
  assert.deepEqual(loaded?.config.providers.relay?.models[0]?.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
  });
  const client = createConfiguredModelCatalog(loaded!.config.providers).createClient("relay", "reasoner");
  assert.deepEqual(client.supportedThinkingLevels, ["low", "medium", "high"]);
});

test("/model reports, lists, and switches every runtime model consumer", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-model-command-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const alpha = fauxProvider({
    provider: "alpha",
    models: [{ id: "alpha-model", name: "Alpha Model", contextWindow: 8_000, maxTokens: 2_000 }],
  });
  const beta = fauxProvider({
    provider: "beta",
    models: [{ id: "team/beta-model", name: "Beta Model", reasoning: true, contextWindow: 16_000, maxTokens: 4_000 }],
  });
  beta.getModel()!.thinkingLevelMap = {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
  };
  const gamma = fauxProvider({
    provider: "gamma",
    models: [{ id: "hidden-model", name: "Hidden Model", contextWindow: 32_000, maxTokens: 8_000 }],
  });
  const models = createModels();
  models.setProvider(alpha.provider);
  models.setProvider(beta.provider);
  models.setProvider(gamma.provider);
  const catalog = new PiModelCatalog(models, [
    { providerId: "alpha", modelId: "alpha-model" },
    { providerId: "beta", modelId: "team/beta-model" },
  ]);
  const app = await ThreadApp.open({
    rootPath: root,
    model: catalog.createClient("alpha", "alpha-model"),
    modelCatalog: catalog,
    thinkingLevel: "high",
  });
  const signal = new AbortController().signal;

  try {
    const pickerResult = await app.handleInput("/model", { signal });
    assert.match(commandContent(pickerResult), /Current model: alpha\/alpha-model/);
    assert.equal(pickerResult.kind === "command" ? pickerResult.result.presentation : undefined, "view");
    const pickerView = pickerResult.kind === "command" ? pickerResult.result.view : undefined;
    assert.equal(pickerView?.type, "model_picker");
    if (!pickerView || pickerView.type !== "model_picker") assert.fail("Expected model picker view");
    assert.equal(pickerView.scope, "configured");
    assert.deepEqual(pickerView.models.map((model) => model.providerId), ["alpha", "beta"]);
    const ui = createUiState("main", "checkpoint", []);
    openEphemeralView(ui, pickerView);
    assert.equal(ui.screen.type, "model_picker");
    if (ui.screen.type !== "model_picker") assert.fail("Expected model picker screen");
    assert.equal(ui.screen.models[ui.screen.selected]?.modelId, "alpha-model");
    ui.screen.selected = moveSelection(ui.screen.selected, 1, ui.screen.models.length);
    assert.equal(ui.screen.models[ui.screen.selected]?.modelId, "team/beta-model");
    ui.screen.selected = moveSelection(ui.screen.selected, 1, ui.screen.models.length);
    assert.equal(ui.screen.models[ui.screen.selected]?.modelId, "alpha-model");

    const controller = new ThreadTuiController(app);
    await controller.submit("/model");
    assert.equal(controller.state.screen.type, "model_picker");
    controller.closeView();
    assert.equal(controller.state.screen.type, "session");
    controller.dispose();

    const allResult = await app.handleInput("/model all", { signal });
    const allView = allResult.kind === "command" ? allResult.result.view : undefined;
    assert.equal(allView?.type, "model_picker");
    if (!allView || allView.type !== "model_picker") assert.fail("Expected complete model picker view");
    assert.equal(allView.scope, "all");
    assert.deepEqual(allView.models.map((model) => model.providerId), ["alpha", "beta", "gamma"]);

    const configuredList = commandContent(await app.handleInput("/model list", { signal }));
    assert.match(configuredList, /alpha\/alpha-model/);
    assert.match(configuredList, /beta\/team\/beta-model/);
    assert.doesNotMatch(configuredList, /gamma\/hidden-model/);

    const listed = commandContent(await app.handleInput("/model list beta", { signal }));
    assert.match(listed, /beta\/team\/beta-model/);
    assert.match(listed, /16,000 context, reasoning/);

    const switched = await app.handleInput("/model beta/team/beta-model", { signal });
    assert.equal(switched.kind === "command" ? switched.result.changedState : false, true);
    assert.equal(app.model?.providerId, "beta");
    assert.equal(app.model?.modelId, "team/beta-model");
    assert.equal(app.thinkingLevel, "high");
    assert.deepEqual(app.availableThinkingLevels, ["low", "medium", "high"]);
    assert.equal(app.capsules.modelLabel, "beta/team/beta-model:high");

    beta.setResponses([
      (_context, options) => {
        assert.equal(options?.reasoning, "high");
        return fauxAssistantMessage("answered by beta");
      },
    ]);
    const turn = await app.handleInput("which model handles this?", { signal });
    assert.equal(turn.kind, "turn");
    assert.equal(beta.state.callCount, 1);
    assert.equal(alpha.state.callCount, 0);

    assert.equal(app.cycleThinkingLevel(), "low");
    assert.equal(app.thinkingLevel, "low");
    assert.equal(app.capsules.modelLabel, "beta/team/beta-model:low");
    beta.setResponses([
      (_context, options) => {
        assert.equal(options?.reasoning, "low");
        return fauxAssistantMessage("answered with low reasoning");
      },
    ]);
    await app.handleInput("use the next thinking level", { signal });

    assert.match(
      commandContent(await app.handleInput("/model alpha alpha-model", { signal })),
      /Switched model from beta\/team\/beta-model to alpha\/alpha-model/,
    );
    assert.equal(app.model?.providerId, "alpha");
    assert.equal(app.thinkingLevel, "off");
    assert.equal(app.cycleThinkingLevel(), undefined);
    assert.equal(app.capsules.modelLabel, "alpha/alpha-model:off");
    await app.handleInput("/model gamma/hidden-model", { signal });
    const pickerWithCurrent = await app.handleInput("/model", { signal });
    const currentView = pickerWithCurrent.kind === "command" ? pickerWithCurrent.result.view : undefined;
    assert.equal(currentView?.type, "model_picker");
    if (!currentView || currentView.type !== "model_picker") assert.fail("Expected configured model picker view");
    assert.deepEqual(currentView.models.map((model) => model.providerId), ["alpha", "beta", "gamma"]);
    assert.equal(currentView.models.find((model) => model.providerId === "gamma")?.modelId, "hidden-model");
    await app.handleInput("/model alpha/alpha-model", { signal });
    await assert.rejects(app.handleInput("/model missing/nope", { signal }), /Unknown model missing\/nope/);
  } finally {
    await app.close();
  }
});

test("an injected model without a catalog can be inspected but not switched", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-injected-model-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const faux = fauxProvider({ provider: "injected", models: [{ id: "only-model" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await ThreadApp.open({ rootPath: root, model: new PiModelCatalog(models).createClient("injected", "only-model") });
  const signal = new AbortController().signal;
  try {
    assert.match(commandContent(await app.handleInput("/model", { signal })), /injected\/only-model/);
    await assert.rejects(app.handleInput("/model injected/other", { signal }), /without a model catalog/);
  } finally {
    await app.close();
  }
});
