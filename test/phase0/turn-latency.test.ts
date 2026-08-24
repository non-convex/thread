import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { PiModelClient } from "../../src/agent/model-client.js";
import { ThreadApp } from "../../src/app.js";
import type { UiEvent } from "../../src/ui/events.js";
import { commitAll, initRepository } from "../helpers/git-fixture.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("the first model request overlaps turn-base capture while tools wait for durability", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-turn-latency-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const modelStarted = deferred();
  const firstVisibleDelta = deferred();
  const faux = fauxProvider();
  faux.setResponses([
    async () => {
      modelStarted.resolve();
      return fauxAssistantMessage([
        fauxText("checking"),
        fauxToolCall("read", { path: "seed.txt" }),
      ], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("done"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await ThreadApp.open({ rootPath: root, model: new PiModelClient(models, faux.getModel()) });

  const snapshotStarted = deferred();
  const releaseSnapshot = deferred();
  const workspace = app.versions.workspace;
  const capture = workspace.capture.bind(workspace);
  let holdNextCapture = true;
  workspace.capture = async (parentRetentionCommitOid?: string) => {
    if (holdNextCapture) {
      holdNextCapture = false;
      snapshotStarted.resolve();
      await releaseSnapshot.promise;
    }
    return capture(parentRetentionCommitOid);
  };

  const events: UiEvent[] = [];
  const active = new AbortController();
  try {
    const resultPromise = app.handleInput("inspect the seed", {
      signal: active.signal,
      onUiEvent: (event) => {
        events.push(event);
        if (event.type === "assistant_text_delta") firstVisibleDelta.resolve();
      },
    });
    await within(snapshotStarted.promise, 2_000);
    await within(modelStarted.promise, 2_000);
    await within(firstVisibleDelta.promise, 2_000);

    assert.ok(events.some((event) => event.type === "turn_started"));
    assert.ok(events.some((event) => event.type === "assistant_started"));
    assert.equal(app.session.projection.getOpenOperations().length, 1);
    assert.equal(app.session.projection.turns.size, 0, "durable turn waits for its base checkpoint");
    assert.equal(
      app.session.projection.records.some((record) => record.type === "tool_started"),
      false,
      "tool execution must remain behind the durable turn-base barrier",
    );

    releaseSnapshot.resolve();
    const result = await resultPromise;
    assert.equal(result.kind, "turn");
    if (result.kind === "turn") assert.equal(result.result.outcome, "completed");
    assert.ok(app.session.projection.records.some((record) => record.type === "tool_started"));
    app.session.projection.assertIdleInvariant(app.versions.currentBranch.name);
  } finally {
    releaseSnapshot.resolve();
    await app.close();
  }
});

test("a failed asynchronous turn-base capture closes the prepared operation", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-turn-preparation-failure-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("response that must not be committed")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await ThreadApp.open({ rootPath: root, model: new PiModelClient(models, faux.getModel()) });
  app.versions.workspace.capture = async () => {
    throw new Error("snapshot failed");
  };

  try {
    const active = new AbortController();
    await assert.rejects(
      app.handleInput("inspect the seed", { signal: active.signal }),
      /snapshot failed/,
    );
    assert.equal(app.session.projection.getOpenOperations().length, 0);
    assert.equal(app.session.projection.turns.size, 0);
    app.session.projection.assertIdleInvariant(app.versions.currentBranch.name);
  } finally {
    await app.close();
  }
});
