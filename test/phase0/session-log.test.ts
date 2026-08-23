import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionLogStore } from "../../src/session/log-store.js";
import { SessionService } from "../../src/session/service.js";

test("session log recovers a partial tail, never replays a never tool and ignores legacy memory", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-log-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const rootPath = path.join(fixture, "workspace");
  const sidecarRoot = path.join(fixture, "sidecar");
  let store = await SessionLogStore.open({ rootPath, sidecarRoot });
  await store.append(
    (_seq, timestamp) => ({
      type: "session_created",
      session: {
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
  const legacySequence = store.projection.nextSequence;
  await store.close();

  await appendFile(
    eventsPath,
    `${JSON.stringify({
      seq: legacySequence,
      timestamp: Date.now(),
      type: "memory_changed",
      memory: {
        id: "memory_legacy",
        scope: "project",
        text: "obsolete external memory",
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        archived: false,
      },
    })}\n`,
    "utf8",
  );
  store = await SessionLogStore.open({ rootPath, sidecarRoot });
  assert.equal(store.projection.nextSequence, legacySequence + 1);
  assert.equal("memories" in store.projection, false);
  await store.close();
});
