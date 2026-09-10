import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ThreadRuntime } from "../src/runtime.js";
import { fixture } from "./fixtures/runtime.js";
import { startRuntimeProcess } from "./fixtures/child-runtime.js";

test("concurrent opens grant exactly one owner, including within the same process", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  // Initialize the manifest before contending for the runtime's repository lock.
  await (await ThreadRuntime.open(f)).close();
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => ThreadRuntime.open(f)));
  const owners = attempts.filter((result) => result.status === "fulfilled").map((result) => result.value);
  try {
    assert.equal(owners.length, 1);
    for (const attempt of attempts) if (attempt.status === "rejected") assert.match(attempt.reason.message, /already open/);
  } finally { await Promise.all(owners.map((owner) => owner.close())); }
});

test("legacy PID contents and empty lock files do not determine lock ownership", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await mkdir(f.stateDirectory);
  const lockPath = path.join(f.stateDirectory, "session-tree.lock");
  for (const contents of [`${process.pid}\n2000-01-01T00:00:00Z\nstale-owner\n`, ""]) {
    await writeFile(lockPath, contents);
    const runtime = await ThreadRuntime.open(f);
    try { await assert.rejects(ThreadRuntime.open(f), /already open/); }
    finally { await runtime.close(); }
    assert.equal(await readFile(lockPath, "utf8"), contents);
  }
});

test("an OS lock without PID metadata rejects another process and survives failed opens", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await mkdir(f.stateDirectory);
  const { child } = await startRuntimeProcess("raw", f.rootPath, f.stateDirectory);
  try {
    for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(ThreadRuntime.open(f), /already open/);
    assert.equal((await stat(path.join(f.stateDirectory, "session-tree.lock"))).size, 0);
  } finally { child.kill(); await child.exited; }
  await (await ThreadRuntime.open(f)).close();
});

test("a lock path that cannot be opened is never removed as stale", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const lockPath = path.join(f.stateDirectory, "session-tree.lock");
  await mkdir(lockPath, { recursive: true });
  await assert.rejects(ThreadRuntime.open(f));
  assert.ok((await stat(lockPath)).isDirectory());
});
