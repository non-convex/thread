import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { ThreadApp } from "../../src/app.js";
import { PiModelCatalog } from "../../src/agent/model-client.js";
import { loadModelState, resolveModelSelection, saveModelState } from "../../src/config/model-state.js";
import { commitAll, initRepository } from "../helpers/git-fixture.js";

test("an interactive model choice is persisted and reused by the next start", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-model-state-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const statePath = path.join(fixture, "state.json");
  const alpha = fauxProvider({ provider: "alpha", models: [{ id: "alpha-model" }] });
  const beta = fauxProvider({
    provider: "beta",
    models: [{ id: "beta-model", reasoning: true, contextWindow: 16_000, maxTokens: 4_000 }],
  });
  beta.getModel()!.thinkingLevelMap = { off: null, minimal: null, low: "low", medium: "medium", high: "high" };
  const models = createModels();
  models.setProvider(alpha.provider);
  models.setProvider(beta.provider);
  const catalog = new PiModelCatalog(models, [
    { providerId: "alpha", modelId: "alpha-model" },
    { providerId: "beta", modelId: "beta-model" },
  ]);

  const writes: Promise<void>[] = [];
  const first = await ThreadApp.open({
    rootPath: root,
    model: catalog.createClient("alpha", "alpha-model"),
    modelCatalog: catalog,
    onModelStateChange: (state) => { writes.push(saveModelState(state, statePath)); },
  });
  try {
    await first.handleInput("/model beta/beta-model", { signal: new AbortController().signal });
    first.cycleThinkingLevel();
    assert.equal(first.cycleThinkingLevel(), "low");
  } finally {
    await first.close();
  }
  // Switching also records the level, so these writes overlap on one path —
  // concurrent renames to one target fail with EPERM on Windows.
  await Promise.all(writes);

  const remembered = await loadModelState(statePath);
  assert.deepEqual(remembered, { model: { provider: "beta", id: "beta-model" }, thinkingLevel: "low" });

  const selection = resolveModelSelection({ state: remembered });
  const second = await ThreadApp.open({
    rootPath: root,
    model: catalog.createClient(selection.model!.provider, selection.model!.id),
    modelCatalog: catalog,
    ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
  });
  try {
    assert.equal(second.model?.modelId, "beta-model");
    assert.equal(second.thinkingLevel, "low");
  } finally {
    await second.close();
  }
});

test("startup selection prefers the CLI pair, then remembered state, then config", () => {
  const state = { model: { provider: "state", id: "state-model" }, thinkingLevel: "low" as const };
  const config = {
    model: { provider: "config", id: "config-model" },
    defaultThinkingLevel: "high" as const,
    providers: {},
  };

  assert.equal(resolveModelSelection({ cli: { provider: "cli", id: "cli-model" }, state, config }).model?.provider, "cli");
  assert.equal(resolveModelSelection({ state, config }).model?.provider, "state");
  assert.equal(resolveModelSelection({ config }).model?.provider, "config");
  assert.equal(resolveModelSelection({ state, config }).thinkingLevel, "low");
  assert.equal(resolveModelSelection({ config }).thinkingLevel, "high");
});

test("an unusable state file degrades to no remembered selection", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-model-state-bad-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));

  assert.equal(await loadModelState(path.join(fixture, "missing.json")), undefined);

  const malformed = path.join(fixture, "malformed.json");
  await writeFile(malformed, "{ not json");
  assert.equal(await loadModelState(malformed), undefined);

  const wrongShape = path.join(fixture, "shape.json");
  await writeFile(wrongShape, JSON.stringify({ model: "beta", thinkingLevel: "unsupported" }));
  assert.equal(await loadModelState(wrongShape), undefined);
});
