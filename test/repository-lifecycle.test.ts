import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentTask } from "../src/core/agent-task/model.js";
import { AgentTaskRepository } from "../src/core/agent-task/repository.js";
import type { Project } from "../src/core/project/model.js";
import type { SessionTreeEvent } from "../src/core/session-tree/model.js";
import { SessionTreeRepository } from "../src/core/session-tree/repository.js";
import { SessionTreeService } from "../src/core/session-tree/service.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-repository-lifecycle-"));
  const project: Project = {
    id: "repository-lifecycle",
    rootPath: directory,
    statePath: path.join(directory, "state"),
  };
  const repositories: { close(): Promise<void> }[] = [];
  t.after(async () => {
    await Promise.all(repositories.map((repository) => repository.close().catch(() => undefined)));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return {
    project,
    async openTree() {
      const repository = await SessionTreeRepository.open(project);
      repositories.push(repository);
      await new SessionTreeService(repository).initialize();
      return repository;
    },
    async openTasks() {
      const repository = await AgentTaskRepository.open(project);
      repositories.push(repository);
      return repository;
    },
  };
}

function sessionCreated(repository: SessionTreeRepository, id: string): SessionTreeEvent {
  return {
    type: "session_created",
    session: { id, treeId: repository.projection.tree!.id, createdAt: Date.now() },
  };
}

// Pause a real durability barrier to exercise shutdown while earlier I/O is
// outstanding, without depending on filesystem speed or timers.
function pauseSync(handle: FileHandle) {
  const entered = deferred();
  const release = deferred();
  const sync = handle.sync.bind(handle);
  handle.sync = async () => {
    entered.resolve();
    await release.promise;
    await sync();
  };
  return { entered: entered.promise, release: release.resolve };
}

test("repeated and concurrent Session Tree close preserve the next owner's lock", async (t) => {
  const values = await fixture(t);
  const first = await values.openTree();
  const closing = first.close();
  assert.strictEqual(first.close(), closing);
  await closing;

  const second = await values.openTree();
  const lockPath = path.join(values.project.statePath, "session-tree.lock");
  const secondLock = await readFile(lockPath, "utf8");
  assert.strictEqual(first.close(), closing);
  await first.close();
  assert.equal(await readFile(lockPath, "utf8"), secondLock);
  await assert.rejects(SessionTreeRepository.open(values.project), /already open/);
  await second.append(() => sessionCreated(second, "still-owned"), true);
  await second.close();

  const third = await values.openTree();
  assert.ok(third.projection.sessions.has("still-owned"));
});

test("Session Tree close drains admitted writes and immediately rejects new writes", async (t) => {
  const values = await fixture(t);
  const repository = await values.openTree();
  const handle = (repository as unknown as { eventsHandle: FileHandle }).eventsHandle;
  const paused = pauseSync(handle);
  t.after(paused.release);
  const earlierFlush = repository.flush();
  await paused.entered;

  const durableAppend = repository.append(() => sessionCreated(repository, "durable"), true);
  const durableBatch = repository.appendBatch(() => [sessionCreated(repository, "batch")], true);
  const backgroundAppend = repository.append(() => sessionCreated(repository, "background"));
  const manifest = repository.writeManifest();
  let closed = false;
  const closing = repository.close();
  void closing.then(() => { closed = true; });
  assert.strictEqual(repository.close(), closing);

  let rejectedFactoryCalls = 0;
  const rejectedEvent = () => {
    rejectedFactoryCalls++;
    return sessionCreated(repository, "rejected");
  };
  await assert.rejects(repository.append(rejectedEvent), /repository is closed/);
  await assert.rejects(repository.appendBatch(() => [rejectedEvent()], true), /repository is closed/);
  await assert.rejects(repository.flush(), /repository is closed/);
  await assert.rejects(repository.writeManifest(), /repository is closed/);
  assert.equal(rejectedFactoryCalls, 0);
  assert.equal(closed, false);

  paused.release();
  await Promise.all([earlierFlush, durableAppend, durableBatch, backgroundAppend, manifest, closing]);
  await assert.rejects(repository.append(rejectedEvent, true), /repository is closed/);
  await assert.rejects(repository.flush(), /repository is closed/);
  await assert.rejects(repository.writeManifest(), /repository is closed/);

  const reopened = await values.openTree();
  for (const id of ["durable", "batch", "background"]) assert.ok(reopened.projection.sessions.has(id));
  assert.equal(reopened.projection.sessions.has("rejected"), false);
});

test("Session Tree only releases a lock bearing its own identity", async (t) => {
  const values = await fixture(t);
  const repository = await values.openTree();
  const lockPath = path.join(values.project.statePath, "session-tree.lock");
  const replacement = `${process.pid}\n${new Date().toISOString()}\nanother-owner\n`;
  await writeFile(lockPath, replacement, "utf8");
  await repository.close();
  assert.equal(await readFile(lockPath, "utf8"), replacement);
});

test("a failed Session Tree open releases its own lock and preserves the load error", async (t) => {
  const values = await fixture(t);
  const repository = await values.openTree();
  await repository.close();
  await writeFile(repository.eventsPath, "invalid JSON\n", "utf8");
  await assert.rejects(SessionTreeRepository.open(values.project), /Invalid JSON/);
  await assert.rejects(readFile(path.join(values.project.statePath, "session-tree.lock")), { code: "ENOENT" });
});

test("Session Tree close preserves a persistence failure and still releases the lock", async (t) => {
  const values = await fixture(t);
  const repository = await values.openTree();
  const handle = (repository as unknown as { eventsHandle: FileHandle }).eventsHandle;
  const failure = new Error("simulated durability failure");
  handle.sync = async () => { throw failure; };
  const flushing = repository.flush();
  const closing = repository.close();
  assert.strictEqual(repository.close(), closing);
  await assert.rejects(flushing, (error) => error === failure);
  await assert.rejects(closing, (error) => error === failure);
  await assert.rejects(repository.close(), (error) => error === failure);
  await values.openTree();
});

function task(id: string): AgentTask {
  return {
    id,
    parentTurnId: "turn",
    toolCallId: "delegate",
    profileId: "worker",
    providerId: "test",
    modelId: "test",
    spec: { title: id, objective: id, guidance: [], acceptanceCriteria: [], writeScope: [] },
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 0,
    runs: [],
    trace: [],
    reviewFeedback: [],
  };
}

test("Agent Task close drains admitted writes, is shared, and rejects later writes", async (t) => {
  const values = await fixture(t);
  const repository = await values.openTasks();
  const handle = (repository as unknown as { handle: FileHandle }).handle;
  const paused = pauseSync(handle);
  t.after(paused.release);
  const earlierFlush = repository.flush();
  await paused.entered;
  const durableAppend = repository.append({ type: "task_created", task: task("durable") }, true);
  const backgroundAppend = repository.append({ type: "task_created", task: task("background") });
  const closing = repository.close();
  assert.strictEqual(repository.close(), closing);
  await assert.rejects(repository.append({ type: "task_created", task: task("rejected") }), /repository is closed/);
  await assert.rejects(repository.flush(), /repository is closed/);
  paused.release();
  await Promise.all([earlierFlush, durableAppend, backgroundAppend, closing]);
  await assert.rejects(repository.append({ type: "task_created", task: task("rejected") }, true), /repository is closed/);
  await assert.rejects(repository.flush(), /repository is closed/);
  const reopened = await values.openTasks();
  assert.ok(reopened.projection.tasks.has("durable"));
  assert.ok(reopened.projection.tasks.has("background"));
  assert.equal(reopened.projection.tasks.has("rejected"), false);
});
