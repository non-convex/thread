import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ThreadApp, type InputResult } from "../../src/app.js";
import { PiModelCatalog } from "../../src/agent/model-client.js";
import { createUiState, moveModelSelection, openEphemeralView } from "../../src/ui/state.js";
import { ScreenDocumentComponent } from "../../src/ui/terminal/components.js";
import { commitAll, initRepository } from "../helpers/git-fixture.js";

function commandContent(result: InputResult): string {
  assert.equal(result.kind, "command");
  return result.kind === "command" ? result.result.content : "";
}

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
  const models = createModels();
  models.setProvider(alpha.provider);
  models.setProvider(beta.provider);
  const catalog = new PiModelCatalog(models);
  const app = await ThreadApp.open({
    rootPath: root,
    model: catalog.createClient("alpha", "alpha-model"),
    modelCatalog: catalog,
  });
  const signal = new AbortController().signal;

  try {
    const pickerResult = await app.handleInput("/model", { signal });
    assert.match(commandContent(pickerResult), /Current model: alpha\/alpha-model/);
    assert.equal(pickerResult.kind === "command" ? pickerResult.result.presentation : undefined, "view");
    const pickerView = pickerResult.kind === "command" ? pickerResult.result.view : undefined;
    assert.equal(pickerView?.type, "model_picker");
    if (!pickerView || pickerView.type !== "model_picker") assert.fail("Expected model picker view");
    const ui = createUiState("main", "checkpoint", []);
    openEphemeralView(ui, pickerView);
    assert.equal(ui.screen.type, "model_picker");
    if (ui.screen.type !== "model_picker") assert.fail("Expected model picker screen");
    assert.equal(ui.screen.models[ui.screen.selected]?.modelId, "alpha-model");
    moveModelSelection(ui.screen, 1);
    assert.equal(ui.screen.models[ui.screen.selected]?.modelId, "team/beta-model");
    moveModelSelection(ui.screen, 1);
    assert.equal(ui.screen.models[ui.screen.selected]?.modelId, "alpha-model");
    const renderedPicker = new ScreenDocumentComponent(() => ui).render(120).join("\n");
    assert.match(renderedPicker, /alpha\/alpha-model/);
    assert.match(renderedPicker, /beta\/team\/beta-model/);

    const listed = commandContent(await app.handleInput("/model list beta", { signal }));
    assert.match(listed, /beta\/team\/beta-model/);
    assert.match(listed, /16,000 context, reasoning/);

    const switched = await app.handleInput("/model beta/team/beta-model", { signal });
    assert.equal(switched.kind === "command" ? switched.result.changedState : false, true);
    assert.equal(app.model?.providerId, "beta");
    assert.equal(app.model?.modelId, "team/beta-model");
    assert.equal(app.capsules.modelLabel, "beta/team/beta-model");

    beta.setResponses([fauxAssistantMessage("answered by beta")]);
    const turn = await app.handleInput("which model handles this?", { signal });
    assert.equal(turn.kind, "turn");
    assert.equal(beta.state.callCount, 1);
    assert.equal(alpha.state.callCount, 0);

    assert.match(
      commandContent(await app.handleInput("/model alpha alpha-model", { signal })),
      /Switched model from beta\/team\/beta-model to alpha\/alpha-model/,
    );
    assert.equal(app.model?.providerId, "alpha");
    assert.equal(app.capsules.modelLabel, "alpha/alpha-model");
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
