import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { ThreadApp } from "../../src/app.js";
import { PiModelClient } from "../../src/agent/model-client.js";
import { COMPACTION_TRIGGER_RATIO } from "../../src/agent/compaction.js";
import { ThreadTuiController } from "../../src/ui/terminal/controller.js";
import { CONTEXT_ESTIMATOR_VERSION, estimateContextTokens } from "../../src/utils/estimate.js";
import { CONTEXT_WARN_PERCENT } from "../../src/ui/terminal/session-screen.js";
import { commitAll, initRepository, removeFixture } from "../helpers/git-fixture.js";

test("the footer counts the prompt prefix the model actually receives", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-ctx-occupancy-"));
  t.after(() => removeFixture(fixture));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxText("done"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await ThreadApp.open({ rootPath: root, model: new PiModelClient(models, faux.getModel()) });
  const controller = new ThreadTuiController(app);

  try {
    const headId = app.versions.head.sessionHeadId;
    const occupancy = app.contextOccupancy(headId);
    assert.ok(occupancy, "a configured model must report occupancy");

    // The system prompt and tool schemas are real request cost; a messages-only
    // estimate drops them entirely before any usage block exists.
    const messagesOnly = estimateContextTokens(app.session.buildContext(headId).messages).tokens;
    assert.ok(
      occupancy.requestTokens > messagesOnly,
      `request tokens ${occupancy.requestTokens} must exceed the messages-only ${messagesOnly}`,
    );
    assert.equal(controller.meta.contextPercent, occupancy.percent, "the footer shows the request budget");
  } finally {
    controller.dispose();
    await app.close();
  }
});

test("a fresh context is not reported as empty", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-ctx-fresh-"));
  t.after(() => removeFixture(fixture));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await ThreadApp.open({ rootPath: root, model: new PiModelClient(models, faux.getModel()) });
  try {
    const occupancy = app.contextOccupancy(app.versions.head.sessionHeadId);
    assert.ok(occupancy && occupancy.requestTokens > 0, "the prefix alone already occupies the window");
  } finally {
    await app.close();
  }
});

test("without a model there is no occupancy to report", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-ctx-nomodel-"));
  t.after(() => removeFixture(fixture));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const app = await ThreadApp.open({ rootPath: root });
  const controller = new ThreadTuiController(app);
  try {
    assert.equal(app.contextOccupancy(app.versions.head.sessionHeadId), undefined);
    assert.equal(controller.meta.contextPercent, 0, "a missing model reads as zero, not a crash");
  } finally {
    controller.dispose();
    await app.close();
  }
});

test("the footer warns before an automatic squash fires", () => {
  const trigger = Math.round(COMPACTION_TRIGGER_RATIO * 100);
  assert.ok(
    CONTEXT_WARN_PERCENT < trigger,
    `warning at ${CONTEXT_WARN_PERCENT}% must precede the ${trigger}% compaction trigger`,
  );
});

test("the estimator version marks the changed percent meaning", () => {
  // v1 recorded a messages-only percent; v2 counts the prompt prefix, so stored
  // costs from the two versions are not comparable.
  assert.equal(CONTEXT_ESTIMATOR_VERSION, "pi-ai-estimate-v2");
});
