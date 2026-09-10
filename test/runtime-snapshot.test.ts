import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ThreadRuntime } from "../src/runtime.js";
import { deferred, fixture, ScriptedModel } from "./fixtures/runtime.js";
import { startRuntimeProcess } from "./fixtures/child-runtime.js";

for (const outcome of ["completed", "interrupted", "failed"] as const) {
  test(`single-session snapshots include recorded active content and settle once when ${outcome}`, async (t) => {
    const f = await fixture(); t.after(f.cleanup);
    await writeFile(path.join(f.rootPath, "note.txt"), "recorded tool result");
    const runtime = await ThreadRuntime.open({ ...f, model: new ScriptedModel(), tools: ["read"] });
    const paused = deferred(), release = deferred();
    let operation: ReturnType<ThreadRuntime["prompt"]> | undefined;
    try {
      const id = runtime.initialSessionId;
      await runtime.prompt(id, "earlier input");
      const other = await runtime.createSession();
      await runtime.prompt(other.id, "other session only");
      runtime.setModel(new ScriptedModel(async (_context, options, call) => {
        if (call === 1) return fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }), { stopReason: "toolUse" });
        options.signal.addEventListener("abort", release.resolve, { once: true });
        paused.resolve();
        await release.promise;
        if (outcome === "failed") throw new Error("fixture model failed");
        return fauxAssistantMessage(fauxText("final response"));
      }));
      operation = runtime.prompt(id, "current input");
      await Promise.race([paused.promise, operation.then(() => { throw new Error("Turn ended before snapshot"); })]);
      const snapshot = runtime.readSession(id);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.activeTurn?.turn.status, "running");
      assert.equal(snapshot.activeTurn?.turn.sessionId, id);
      const active = snapshot.activeTurn!;
      assert.match(JSON.stringify(active.entries), /current input/);
      assert.match(JSON.stringify(active.entries), /recorded tool result/);
      assert.doesNotMatch(JSON.stringify(snapshot), /other session only/);
      assert.equal(runtime.readSession(other.id).activeTurn, null);
      assert.equal(new Set(active.entries.map((entry) => entry.id)).size, active.entries.length);
      active.entries.length = 0;
      active.turn.status = "failed";
      assert.equal(runtime.readSession(id).activeTurn?.turn.status, "running");
      assert.ok(runtime.readSession(id).activeTurn!.entries.length > 0);
      if (outcome === "interrupted") await runtime.interrupt(id);
      else release.resolve();
      const result = await operation;
      assert.equal(result.outcome, outcome);
      const settled = runtime.readSession(id);
      assert.equal(settled.activeTurn, null);
      assert.equal(settled.turns.length, 2);
      assert.equal(settled.turns.at(-1)?.status, outcome);
      assert.equal(settled.turns.filter((turn) => turn.id === active.turn.id).length, 1);
      await runtime.rewind(id, result.turn.id);
      assert.equal(runtime.readSession(id).turns.length, 1);
      assert.equal(runtime.readSession(id).activeTurn, null);
    } finally { release.resolve(); await operation; await runtime.close(); }
  });
}

test("process death releases the lock and reopening seals the recorded active turn", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await writeFile(path.join(f.rootPath, "note.txt"), "survives process death");
  const { child, sessionId } = await startRuntimeProcess("running", f.rootPath, f.stateDirectory);
  try { await assert.rejects(ThreadRuntime.open(f), /already open/); }
  finally { child.kill(); await child.exited; }
  const runtime = await ThreadRuntime.open(f);
  try {
    const snapshot = runtime.readSession(sessionId!);
    assert.equal(snapshot.activeTurn, null);
    assert.equal(snapshot.turns.length, 1);
    assert.equal(snapshot.turns[0]!.status, "interrupted");
    assert.match(JSON.stringify(snapshot.entries), /recover this input/);
    assert.match(JSON.stringify(snapshot.entries), /survives process death/);
  } finally { await runtime.close(); }
});
