import assert from "node:assert/strict";
import { access, appendFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadApp } from "../../src/app.js";
import { ThreadTuiController } from "../../src/ui/terminal/controller.js";
import { createId } from "../../src/utils/id.js";
import { discoverGitWorkspace } from "../../src/workspace/discovery.js";
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

test("/new creates an empty session and /session switches workspace plus context", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-project-sessions-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const signal = new AbortController().signal;
  let app = await ThreadApp.open({ rootPath: root });
  let oldId = "";
  let newId = "";
  try {
    oldId = app.session.store.sessionId;
    await writeFile(path.join(root, "old-only.txt"), "old session\n");
    await appendUserState(app, "old session context");
    const oldSession = app.session;
    const oldCheckpointCount = oldSession.projection.checkpoints.size;

    const controller = new ThreadTuiController(app);
    try {
      assert.ok(controller.state.transcript.some((item) => item.content === "old session context"));
      assert.ok(controller.slashSuggestions.some((item) => item.name === "new"));
      assert.ok(controller.slashSuggestions.some((item) => item.name === "session"));
      await controller.submit("/new");
      assert.deepEqual(controller.state.transcript, [], "session_changed clears the old transcript projection");
      assert.equal(controller.state.branch, "main");
    } finally {
      controller.dispose();
    }

    newId = app.session.store.sessionId;
    assert.notEqual(newId, oldId);
    assert.equal(app.versions.currentBranch.name, "main");
    assert.equal(app.versions.head.sessionHeadId, null);
    assert.equal(app.session.projection.entries.size, 0);
    assert.equal(app.session.projection.turns.size, 0);
    assert.equal(await Bun.file(path.join(root, "old-only.txt")).text(), "old session\n");
    assert.equal(oldSession.projection.checkpoints.size, oldCheckpointCount + 1);
    assert.equal([...oldSession.projection.checkpoints.values()].at(-1)?.reason, "safety");

    const listed = await app.handleInput("/session", { signal });
    assert.equal(listed.kind, "command");
    const view = listed.kind === "command" ? listed.result.view : undefined;
    assert.equal(view?.type, "session_picker");
    if (!view || view.type !== "session_picker") assert.fail("Expected a session picker");
    assert.equal(view.sessions.length, 2);
    assert.equal(view.sessions[0]?.id, newId);
    assert.equal(view.sessions[0]?.current, true);
    assert.equal(view.sessions[1]?.id, oldId);

    await rm(path.join(root, "old-only.txt"));
    await writeFile(path.join(root, "new-only.txt"), "new session\n");
    await appendUserState(app, "new session context");

    await assert.rejects(
      app.handleInput("/session switch session_", { signal }),
      /ambiguous/,
    );
    await app.handleInput(`/session switch ${oldId.slice(0, 20)}`, { signal });
    assert.equal(app.session.store.sessionId, oldId);
    assert.equal(await Bun.file(path.join(root, "old-only.txt")).text(), "old session\n");
    await assert.rejects(access(path.join(root, "new-only.txt")));
    assert.match(contextText(app), /old session context/);
    assert.doesNotMatch(contextText(app), /new session context/);

    await app.handleInput(`/session switch ${newId}`, { signal });
    assert.equal(app.session.store.sessionId, newId);
    assert.equal(await Bun.file(path.join(root, "new-only.txt")).text(), "new session\n");
    await assert.rejects(access(path.join(root, "old-only.txt")));
    assert.match(contextText(app), /new session context/);
    assert.equal(
      [...app.session.projection.entries.values()].some((entry) => entry.type === "context_merge"),
      false,
    );
    assert.deepEqual(await app.fsck(), []);
  } finally {
    await app.close();
  }

  app = await ThreadApp.open({ rootPath: root });
  try {
    assert.equal(app.session.store.sessionId, newId, "startup loads the last activated session");
    await app.handleInput(`/session switch ${oldId}`, { signal });
  } finally {
    await app.close();
  }

  app = await ThreadApp.open({ rootPath: root });
  try {
    assert.equal(app.session.store.sessionId, oldId, "an explicit activation becomes the next startup default");
    await app.deleteProjectSession();
  } finally {
    await app.close();
  }

  app = await ThreadApp.open({ rootPath: root });
  try {
    assert.equal(app.session.store.sessionId, newId, "deleting the active session activates the newest remainder");
    assert.equal(await Bun.file(path.join(root, "new-only.txt")).text(), "new session\n");
    await assert.rejects(access(path.join(root, "old-only.txt")));
  } finally {
    await app.close();
  }
});

test("an existing path-derived session is adopted when no project catalog exists", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-session-migration-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  let app = await ThreadApp.open({ rootPath: root });
  const legacyId = app.session.store.sessionId;
  await appendUserState(app, "legacy context survives catalog migration");
  const sequence = app.session.projection.nextSequence;
  await app.close();

  const workspace = await discoverGitWorkspace(root);
  const projectsDir = path.join(workspace.sidecarRoot, "projects");
  for (const name of await readdir(projectsDir)) await rm(path.join(projectsDir, name));

  app = await ThreadApp.open({ rootPath: root });
  try {
    assert.equal(app.session.store.sessionId, legacyId);
    assert.equal(app.session.projection.nextSequence, sequence);
    assert.match(contextText(app), /legacy context survives catalog migration/);
    assert.equal((await readdir(projectsDir)).filter((name) => name.endsWith(".json")).length, 1);
  } finally {
    await app.close();
  }
});

test("a failed or concurrent session transition keeps the active session unchanged", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-session-failure-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const signal = new AbortController().signal;
  let app = await ThreadApp.open({ rootPath: root });
  try {
    const originalCapture = app.versions.workspace.capture.bind(app.versions.workspace);
    let releaseCapture: () => void = () => {};
    const captureGate = new Promise<void>((resolve) => { releaseCapture = resolve; });
    app.versions.workspace.capture = async (parent) => {
      await captureGate;
      return originalCapture(parent);
    };
    const firstNew = app.handleInput("/new", { signal });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      app.handleInput("/new", { signal }),
      /transition is already running/,
    );
    releaseCapture();
    await firstNew;

    const currentId = app.session.store.sessionId;
    const sessionsResult = await app.handleInput("/session", { signal });
    const view = sessionsResult.kind === "command" ? sessionsResult.result.view : undefined;
    if (!view || view.type !== "session_picker") assert.fail("Expected a session picker");
    const inactiveId = view.sessions.find((session) => !session.current)!.id;
    const workspace = await discoverGitWorkspace(root);
    await appendFile(
      path.join(workspace.sidecarRoot, "sessions", inactiveId, "events.jsonl"),
      "{not valid json}\n",
      "utf8",
    );
    await assert.rejects(
      app.handleInput(`/session switch ${inactiveId}`, { signal }),
      /Invalid JSON/,
    );
    assert.equal(app.session.store.sessionId, currentId);
    await assert.rejects(
      app.handleInput("/session switch session_missing", { signal }),
      /Unknown project session/,
    );
  } finally {
    await app.close();
  }

  app = await ThreadApp.open({ rootPath: root });
  try {
    assert.equal((await app.handleInput("/session", { signal })).kind, "command");
  } finally {
    await app.close();
  }
});
