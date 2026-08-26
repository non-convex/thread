import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { ThreadApp } from "../../src/app.js";
import { PiModelCatalog } from "../../src/agent/model-client.js";
import {
  loadModelState,
  resolveModelSelection,
  saveModelState,
  type ModelState,
} from "../../src/config/model-state.js";
import { commitAll, initRepository } from "../helpers/git-fixture.js";

async function fixtureRepository(t: { after(fn: () => unknown): void }, label: string): Promise<string> {
  const fixture = await mkdtemp(path.join(tmpdir(), label));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");
  return root;
}

function twoProviderCatalog(): PiModelCatalog {
  const alpha = fauxProvider({
    provider: "alpha",
    models: [{ id: "alpha-model", contextWindow: 8_000, maxTokens: 2_000 }],
  });
  const beta = fauxProvider({
    provider: "beta",
    models: [{ id: "beta-model", reasoning: true, contextWindow: 16_000, maxTokens: 4_000 }],
  });
  beta.getModel()!.thinkingLevelMap = { off: null, minimal: null, low: "low", medium: "medium", high: "high" };
  const models = createModels();
  models.setProvider(alpha.provider);
  models.setProvider(beta.provider);
  return new PiModelCatalog(models, [
    { providerId: "alpha", modelId: "alpha-model" },
    { providerId: "beta", modelId: "beta-model" },
  ]);
}

test("/model and thinking-level changes are reported for persistence and survive a restart", async (t) => {
  const root = await fixtureRepository(t, "thread-model-state-");
  const statePath = path.join(root, ".thread-state.json");
  const catalog = twoProviderCatalog();
  const signal = new AbortController().signal;
  const writes: Promise<void>[] = [];

  const first = await ThreadApp.open({
    rootPath: root,
    model: catalog.createClient("alpha", "alpha-model"),
    modelCatalog: catalog,
    onModelStateChange: (state) => { writes.push(saveModelState(state, statePath)); },
  });
  try {
    await first.handleInput("/model beta/beta-model", { signal });
    // beta supports low/medium/high; the default preference is medium, so two
    // cycles land on low (medium → high → low).
    assert.equal(first.cycleThinkingLevel(), "high");
    assert.equal(first.cycleThinkingLevel(), "low");
  } finally {
    await first.close();
  }
  await Promise.all(writes);

  const remembered = await loadModelState(statePath);
  assert.deepEqual(remembered, { model: { provider: "beta", id: "beta-model" }, thinkingLevel: "low" });

  // A restart resolves its startup selection from the remembered state.
  const selection = resolveModelSelection({ state: remembered, config: { providers: {} } });
  assert.deepEqual(selection.model, { provider: "beta", id: "beta-model" });
  const second = await ThreadApp.open({
    rootPath: root,
    model: catalog.createClient(selection.model!.provider, selection.model!.id),
    modelCatalog: catalog,
    ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
  });
  try {
    assert.equal(second.model?.providerId, "beta");
    assert.equal(second.model?.modelId, "beta-model");
    assert.equal(second.thinkingLevel, "low");
  } finally {
    await second.close();
  }
});

test("a /new branch keeps the switched model and thinking level", async (t) => {
  const root = await fixtureRepository(t, "thread-model-state-new-");
  const catalog = twoProviderCatalog();
  const signal = new AbortController().signal;
  const app = await ThreadApp.open({
    rootPath: root,
    model: catalog.createClient("alpha", "alpha-model"),
    modelCatalog: catalog,
  });
  try {
    await app.handleInput("/model beta/beta-model", { signal });
    assert.equal(app.cycleThinkingLevel(), "high");
    assert.equal(app.cycleThinkingLevel(), "low");
    await app.handleInput("/new", { signal });
    assert.equal(app.model?.providerId, "beta");
    assert.equal(app.model?.modelId, "beta-model");
    assert.equal(app.thinkingLevel, "low");
  } finally {
    await app.close();
  }
});

test("model state precedence prefers the CLI pair, then remembered state, then config", () => {
  const state: ModelState = { model: { provider: "state", id: "state-model" }, thinkingLevel: "low" };
  const config = {
    model: { provider: "config", id: "config-model" },
    defaultThinkingLevel: "high" as const,
    providers: {},
  };

  assert.deepEqual(
    resolveModelSelection({ cli: { provider: "cli", id: "cli-model" }, state, config }).model,
    { provider: "cli", id: "cli-model" },
  );
  assert.deepEqual(resolveModelSelection({ state, config }).model, { provider: "state", id: "state-model" });
  assert.deepEqual(resolveModelSelection({ config }).model, { provider: "config", id: "config-model" });

  // A remembered level outranks the configured default; without state the
  // configured default still applies.
  assert.equal(resolveModelSelection({ state, config }).thinkingLevel, "low");
  assert.equal(resolveModelSelection({ config }).thinkingLevel, "high");
  assert.deepEqual(resolveModelSelection({}), {});
});

test("an unreadable or malformed model state file is ignored rather than fatal", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-model-state-bad-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));

  assert.equal(await loadModelState(path.join(fixture, "missing.json")), undefined);

  const malformed = path.join(fixture, "malformed.json");
  await writeFile(malformed, "{ not json");
  assert.equal(await loadModelState(malformed), undefined);

  const wrongShape = path.join(fixture, "shape.json");
  await writeFile(wrongShape, JSON.stringify({ model: "beta", thinkingLevel: "unsupported" }));
  assert.equal(await loadModelState(wrongShape), undefined);

  // A recognizable half is kept even when the rest is unusable.
  const partial = path.join(fixture, "partial.json");
  await writeFile(partial, JSON.stringify({ model: { provider: "beta", id: "beta-model" }, thinkingLevel: 7 }));
  assert.deepEqual(await loadModelState(partial), { model: { provider: "beta", id: "beta-model" } });
});

test("saved model state is written atomically and replaces earlier state", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-model-state-write-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const statePath = path.join(fixture, "nested", "state.json");

  await saveModelState({ model: { provider: "alpha", id: "alpha-model" }, thinkingLevel: "high" }, statePath);
  await saveModelState({ model: { provider: "beta", id: "beta-model" }, thinkingLevel: "low" }, statePath);

  assert.deepEqual(await loadModelState(statePath), {
    model: { provider: "beta", id: "beta-model" },
    thinkingLevel: "low",
  });
  assert.match(await readFile(statePath, "utf8"), /^\{\n/, "state is stored as readable JSON");
});

test("overlapping saves to one path serialize instead of racing on the rename", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-model-state-race-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const statePath = path.join(fixture, "state.json");

  const levels = ["off", "minimal", "low", "medium", "high"] as const;
  await Promise.all(levels.map((level) =>
    saveModelState({ model: { provider: "beta", id: "beta-model" }, thinkingLevel: level }, statePath)
  ));

  const loaded = await loadModelState(statePath);
  assert.deepEqual(loaded?.model, { provider: "beta", id: "beta-model" });
  assert.ok(levels.includes(loaded?.thinkingLevel as (typeof levels)[number]), "one full write wins");
});
