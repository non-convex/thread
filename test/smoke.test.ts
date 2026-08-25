import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ThreadApp } from "../src/app.js";
import { PiModelClient } from "../src/agent/model-client.js";
import { loadExtension } from "../src/extensions/loader.js";
import { commitAll, initRepository } from "./helpers/git-fixture.js";

function replyText(messages: ReadonlyArray<{ content: ReadonlyArray<{ type: string; text?: string }> }>): string {
  return messages.at(-1)?.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("") ?? "";
}

test("one project session can branch, restore, diff and merge workspace plus context", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-smoke-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, ".gitignore"), ".thread/\n");
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "main.txt", content: "main\n" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("main work complete"),
    fauxAssistantMessage("main context capsule"),
    fauxAssistantMessage(fauxToolCall("write", { path: "feature.txt", content: "feature\n" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("feature work complete"),
    fauxAssistantMessage("feature context capsule"),
    fauxAssistantMessage("default diff facts: feature.txt changed since the last thread commit"),
    fauxAssistantMessage("diff facts: main.txt and feature.txt differ"),
    fauxAssistantMessage("semantic thread diff"),
    fauxAssistantMessage("merged context capsule"),
  ]);
  const model = new PiModelClient(models, faux.getModel());
  let app = await ThreadApp.open({ rootPath: root, model });
  const signal = new AbortController().signal;
  let expectedKeepRef: string | undefined;
  try {
    await loadExtension(path.resolve("examples/extension.mjs"), app.extensionApi, process.cwd());
    assert.ok(app.tools.get("echo_local"));
    const extensionCommand = await app.handleInput("/thread hello", { signal });
    assert.match(extensionCommand.kind === "command" ? extensionCommand.result.content : "", /hello from/);
    const mainTurn = await app.handleInput("create the main implementation", { signal });
    assert.equal(mainTurn.kind, "turn");
    assert.equal(mainTurn.kind === "turn" ? mainTurn.result.outcome : undefined, "completed");
    await app.handleInput("/thread commit main milestone", { signal });
    const mainCommit = [...app.session.projection.commits.values()].at(-1)!;
    const mainContextHead = app.versions.head.sessionHeadId;

    await app.handleInput("/thread branch feature", { signal });
    const featureTurn = await app.handleInput("build the feature", { signal });
    assert.equal(featureTurn.kind === "turn" ? featureTurn.result.outcome : undefined, "completed");
    await app.handleInput("/thread commit feature milestone", { signal });
    const featureCommit = [...app.session.projection.commits.values()].at(-1)!;
    /* Bare /thread diff is captured and re-issued to the agent as a wrapped
     * user message; the reply is an ordinary turn, not a command result. */
    const defaultDiff = await app.handleInput("/thread diff --facts", { signal });
    assert.equal(defaultDiff.kind, "turn");
    if (defaultDiff.kind !== "turn") assert.fail("expected a diff turn");
    assert.equal(defaultDiff.result.outcome, "completed");
    assert.match(replyText(defaultDiff.result.messages), /feature\.txt/, "the wrapped diff turn replies through the model");
    assert.equal(await readFile(path.join(root, "feature.txt"), "utf8"), "feature\n");
    assert.equal(app.tools.get("memory_write"), undefined);
    assert.equal(app.tools.get("memory_search"), undefined);
    assert.equal(app.tools.get("memory_archive"), undefined);
    const featureTurnId = featureTurn.kind === "turn" ? featureTurn.result.turn.id : "";
    const rewindPicker = await app.handleInput("/rewind", { signal });
    assert.equal(rewindPicker.kind, "command");
    const rewindView = rewindPicker.kind === "command" ? rewindPicker.result.view : undefined;
    assert.equal(rewindView?.type, "rewind", "bare /rewind opens the message picker");
    if (!rewindView || rewindView.type !== "rewind") assert.fail("Expected rewind picker view");
    const rewindLabels = rewindView.items.map((item) => item.label);
    assert.equal(rewindLabels.length, 2, "the wrapped diff turn is a rewindable turn like any other");
    assert.match(rewindLabels[0]!, /\/thread diff --facts/, "newest turn is the wrapped diff command");
    assert.equal(rewindLabels[1]!, "build the feature");
    await app.handleInput(`/rewind ${featureTurnId}`, { signal });
    await assert.rejects(access(path.join(root, "feature.txt")));
    await app.handleInput(`/thread restore ${featureCommit.id}`, { signal });
    assert.equal(await readFile(path.join(root, "feature.txt"), "utf8"), "feature\n");

    await app.handleInput("/thread switch main", { signal });
    await assert.rejects(access(path.join(root, "feature.txt")));
    assert.equal(app.versions.head.sessionHeadId, mainContextHead);
    const facts = await app.handleInput("/thread diff main feature --facts", { signal });
    assert.equal(facts.kind, "turn");
    if (facts.kind !== "turn") assert.fail("expected a diff turn");
    assert.match(replyText(facts.result.messages), /feature\.txt/, "explicit refs are translated into the wrapped prompt");
    const entryCountBeforeSemanticDiff = app.session.projection.entries.size;
    const semanticDiff = await app.handleInput("/thread diff main feature", { signal });
    assert.equal(semanticDiff.kind, "turn");
    if (semanticDiff.kind !== "turn") assert.fail("expected a diff turn");
    assert.match(replyText(semanticDiff.result.messages), /semantic thread diff/);
    assert.equal(
      app.session.projection.entries.size,
      entryCountBeforeSemanticDiff + 2,
      "a wrapped diff turn appends its user and assistant entries",
    );

    await app.handleInput(`/thread restore ${mainCommit.id}`, { signal });
    const merged = await app.handleInput("/thread merge feature --context=keep-current", { signal });
    assert.equal(merged.kind, "command");
    assert.equal(await readFile(path.join(root, "feature.txt"), "utf8"), "feature\n");
    assert.equal(await app.fsck().then((issues) => issues.length), 0);
    expectedKeepRef = app.versions.expectedKeepRef;
    const genesisRetention = [...app.session.projection.checkpoints.values()][0]!.retentionCommitOid;
    await app.versions.workspace.updateKeepRef(genesisRetention);
  } finally {
    await app.close();
  }

  app = await ThreadApp.open({ rootPath: root });
  try {
    assert.equal(app.versions.currentBranch.name, "main");
    assert.equal(await readFile(path.join(root, "feature.txt"), "utf8"), "feature\n");
    assert.equal(app.session.projection.getOpenOperations().length, 0);
    assert.equal(await app.versions.workspace.readKeepRef(), expectedKeepRef);
  } finally {
    await app.close();
  }
});
