import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadApp } from "../../src/app.js";
import { ThreadTuiController } from "../../src/ui/terminal/controller.js";
import { createId } from "../../src/utils/id.js";
import { commitAll, initRepository } from "../helpers/git-fixture.js";

async function appendUserState(app: ThreadApp, content: string): Promise<void> {
  const branch = app.versions.currentBranch.name;
  await app.session.appendEntry(
    branch,
    {
      id: createId("entry"),
      sessionId: app.session.store.sessionId,
      type: "message",
      message: { role: "user", content, timestamp: Date.now() },
    },
    true,
  );
  const snapshot = await app.versions.workspace.capture(app.versions.expectedKeepRef);
  await app.versions.persistCheckpoint(snapshot, {
    reason: "command",
    parentCheckpointIds: [app.versions.head.id],
    sessionHeadId: app.session.projection.lanes.get(branch) ?? null,
  });
}

function contextText(app: ThreadApp): string {
  return app.session.buildContext(app.versions.head.sessionHeadId).messages
    .map((message) => typeof message.content === "string" ? message.content : "")
    .join("\n");
}

test("/new creates an empty-context root branch while preserving the current workspace", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-new-branch-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const signal = new AbortController().signal;
  let app = await ThreadApp.open({ rootPath: root });
  const treeId = app.session.store.sessionId;
  const genesis = app.versions.head;
  try {
    await writeFile(path.join(root, "current-only.txt"), "preserved\n");
    await appendUserState(app, "context on main");
    const mainContextHead = app.versions.head.sessionHeadId;

    const controller = new ThreadTuiController(app);
    try {
      assert.ok(controller.slashSuggestions.some((item) => item.name === "new"));
      assert.ok(!controller.slashSuggestions.some((item) => item.name === "session"));
      await controller.submit("/new");
      assert.deepEqual(controller.state.transcript, []);
      assert.equal(controller.state.branch, "new-1");
    } finally {
      controller.dispose();
    }

    assert.equal(app.session.store.sessionId, treeId, "/new stays in one Session Tree");
    assert.equal(app.versions.currentBranch.name, "new-1");
    assert.equal(app.versions.head.reason, "new");
    assert.deepEqual(app.versions.head.parentCheckpointIds, [genesis.id]);
    assert.equal(app.versions.head.sessionHeadId, null);
    assert.equal(contextText(app), "");
    assert.equal(await Bun.file(path.join(root, "current-only.txt")).text(), "preserved\n");

    const workspaceSourceId = app.versions.head.details?.workspaceSourceCheckpointId;
    assert.ok(workspaceSourceId);
    const workspaceSource = app.versions.getCheckpoint(workspaceSourceId);
    assert.equal(workspaceSource.reason, "safety");
    assert.equal(app.versions.head.workspaceTreeOid, workspaceSource.workspaceTreeOid);
    assert.equal(app.versions.head.retentionCommitOid, workspaceSource.retentionCommitOid);
    assert.equal(app.session.projection.branches.get("main")?.headCheckpointId, workspaceSource.id);
    assert.equal(app.session.projection.lanes.get("main"), mainContextHead);

    await writeFile(path.join(root, "new-only.txt"), "new branch\n");
    await appendUserState(app, "context on new-1");
    await app.handleInput("/thread switch main", { signal });
    assert.match(contextText(app), /context on main/);
    assert.doesNotMatch(contextText(app), /context on new-1/);
    await access(path.join(root, "current-only.txt"));
    await assert.rejects(access(path.join(root, "new-only.txt")));

    await app.handleInput("/new", { signal });
    assert.equal(app.versions.currentBranch.name, "new-2");
    assert.equal(app.versions.head.sessionHeadId, null);
    assert.deepEqual(app.versions.head.parentCheckpointIds, [genesis.id]);
    assert.equal(await Bun.file(path.join(root, "current-only.txt")).text(), "preserved\n");
    assert.deepEqual(await app.fsck(), []);
  } finally {
    await app.close();
  }

  app = await ThreadApp.open({ rootPath: root });
  try {
    assert.equal(app.session.store.sessionId, treeId);
    assert.equal(app.versions.currentBranch.name, "new-2");
    assert.equal(app.versions.head.sessionHeadId, null);
    assert.equal(await Bun.file(path.join(root, "current-only.txt")).text(), "preserved\n");
  } finally {
    await app.close();
  }
});

test("concurrent /new commands cannot create competing root branches", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-new-concurrency-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const app = await ThreadApp.open({ rootPath: root });
  try {
    const originalCapture = app.versions.workspace.capture.bind(app.versions.workspace);
    let releaseCapture: () => void = () => {};
    const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
    app.versions.workspace.capture = async (parent) => {
      await captureGate;
      return originalCapture(parent);
    };
    const signal = new AbortController().signal;
    const first = app.handleInput("/new", { signal });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(app.handleInput("/new", { signal }), /transition is already running/);
    releaseCapture();
    await first;
    assert.equal(app.versions.currentBranch.name, "new-1");
    assert.equal(app.session.projection.branches.size, 2);
    assert.deepEqual(await app.fsck(), []);
  } finally {
    await app.close();
  }
});

test("replay rejects a /new checkpoint whose borrowed workspace identity was altered", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-new-provenance-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const app = await ThreadApp.open({ rootPath: root });
  await writeFile(path.join(root, "changed.txt"), "current\n");
  await app.handleInput("/new", { signal: new AbortController().signal });
  const eventsPath = app.session.store.eventsPath;
  await app.close();

  type SerializedEvent = {
    type?: string;
    checkpoint?: { reason?: string; workspaceTreeOid?: string };
  };
  type SerializedRecord = { type?: string; events?: SerializedEvent[] };
  const records = (await readFile(eventsPath, "utf8")).trimEnd().split(/\r?\n/)
    .map((line) => JSON.parse(line) as SerializedRecord);
  const newEvent = records
    .flatMap((record) => record.type === "batch" ? record.events ?? [] : [record as SerializedEvent])
    .find((event) => event.type === "checkpoint_created" && event.checkpoint?.reason === "new");
  assert.ok(newEvent?.checkpoint);
  newEvent.checkpoint.workspaceTreeOid = "0".repeat(40);
  await writeFile(eventsPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  await assert.rejects(
    ThreadApp.open({ rootPath: root }),
    /changed its borrowed workspace identity/,
  );
});
