import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionLogStore } from "../../src/session/log-store.js";
import { SessionService } from "../../src/session/service.js";

test("session log recovers a partial tail and never replays a never tool", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-log-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const rootPath = path.join(fixture, "workspace");
  const sidecarRoot = path.join(fixture, "sidecar");
  let store = await SessionLogStore.open({ rootPath, sidecarRoot });
  await store.append(
    (_seq, timestamp) => ({
      type: "tree_created",
      tree: {
        formatVersion: 3,
        id: store.sessionId,
        rootPath,
        currentBranch: "main",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    }),
    { flush: true },
  );
  const session = new SessionService(store);
  await session.appendRecord(
    {
      id: "operation_open",
      type: "operation_started",
      lane: "main",
      sourceLeafId: null,
      intent: { kind: "run", originalPrompt: [], initialEntryIds: [] },
    },
    true,
  );
  await session.appendRecord(
    {
      id: "tool_started",
      type: "tool_started",
      lane: "main",
      runId: "operation_open",
      assistantEntryId: "assistant_reserved",
      toolIndex: 0,
      toolCallId: "call_1",
      toolName: "write",
      effectiveArgs: { path: "value.txt", content: "once" },
      resultEntryId: "result_reserved",
      replay: "never",
    },
    true,
  );
  const eventsPath = store.eventsPath;
  await store.close();
  await appendFile(eventsPath, '{"seq":4,"timestamp":', "utf8");

  store = await SessionLogStore.open({ rootPath, sidecarRoot });
  const recovered = new SessionService(store);
  assert.equal(store.projection.nextSequence, 4);
  assert.deepEqual(await recovered.finishInterruptedOperations(), ["operation_open"]);
  assert.equal(store.projection.getOpenOperations().length, 0);
  assert.equal(store.projection.records.filter((record) => record.type === "tool_started").length, 1);
  assert.equal(store.projection.entries.size, 0);
  await store.close();
});

test("old compaction entries fail explicitly instead of activating a compatibility path", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-old-compaction-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const rootPath = path.join(fixture, "workspace");
  const sidecarRoot = path.join(fixture, "sidecar");
  const store = await SessionLogStore.open({ rootPath, sidecarRoot });
  const eventsPath = store.eventsPath;
  const sessionId = store.sessionId;
  await store.close();
  await appendFile(eventsPath, `${JSON.stringify({
    seq: 1,
    timestamp: Date.now(),
    type: "entry_appended",
    lane: "main",
    entry: {
      id: "entry_old_compaction",
      sessionId,
      seq: 1,
      parentId: null,
      timestamp: Date.now(),
      type: "compaction",
      summary: "old",
      retainedTail: [],
      tokensBefore: 10,
    },
  })}\n`, "utf8");
  await assert.rejects(
    SessionLogStore.open({ rootPath, sidecarRoot }),
    /Unsupported session entry type: compaction/,
  );
});

test("legacy Session Tree formats are rejected at the log boundary", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-old-format-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const rootPath = path.join(fixture, "workspace");
  const sidecarRoot = path.join(fixture, "sidecar");
  const store = await SessionLogStore.open({ rootPath, sidecarRoot });
  const eventsPath = store.eventsPath;
  const sessionId = store.sessionId;
  await store.close();
  await appendFile(eventsPath, `${JSON.stringify({
    seq: 1,
    timestamp: Date.now(),
    type: "tree_created",
    tree: {
      id: sessionId,
      rootPath,
      currentBranch: "main",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  })}\n`, "utf8");
  await assert.rejects(
    SessionLogStore.open({ rootPath, sidecarRoot }),
    /Unsupported Session Tree format: legacy/,
  );
});

test("multi-session format 2 is rejected instead of loading a compatibility path", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-multi-session-format-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const rootPath = path.join(fixture, "workspace");
  const sidecarRoot = path.join(fixture, "sidecar");
  const store = await SessionLogStore.open({ rootPath, sidecarRoot });
  const eventsPath = store.eventsPath;
  const sessionId = store.sessionId;
  await store.close();
  const timestamp = Date.now();
  await appendFile(eventsPath, `${JSON.stringify({
    seq: 1,
    timestamp,
    type: "session_created",
    session: {
      formatVersion: 2,
      id: sessionId,
      rootPath,
      currentBranch: "main",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  })}\n`, "utf8");
  await assert.rejects(
    SessionLogStore.open({ rootPath, sidecarRoot }),
    /Unsupported Session Tree format: 2 \(legacy session_created event\)/,
  );
});

test("removed navigation operations are rejected instead of retained as dormant compatibility data", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-old-operation-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const rootPath = path.join(fixture, "workspace");
  const sidecarRoot = path.join(fixture, "sidecar");
  const store = await SessionLogStore.open({ rootPath, sidecarRoot });
  const eventsPath = store.eventsPath;
  const sessionId = store.sessionId;
  await store.close();
  const timestamp = Date.now();
  await appendFile(eventsPath, [
    JSON.stringify({
      seq: 1,
      timestamp,
      type: "tree_created",
      tree: { formatVersion: 3, id: sessionId, rootPath, currentBranch: "main", createdAt: timestamp, updatedAt: timestamp },
    }),
    JSON.stringify({
      seq: 2,
      timestamp,
      type: "record_appended",
      record: {
        id: "operation_old_navigation",
        seq: 2,
        timestamp,
        type: "operation_started",
        lane: "main",
        sourceLeafId: null,
        intent: { kind: "navigation", targetId: null, summarize: true },
      },
    }),
    "",
  ].join("\n"), "utf8");
  await assert.rejects(
    SessionLogStore.open({ rootPath, sidecarRoot }),
    /Unsupported operation intent: navigation/,
  );
});
