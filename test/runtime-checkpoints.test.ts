import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ModelClient } from "../src/core/agent/model-client.js";
import { FILE_EDITING_PROMPT } from "../src/core/tools/file-editing-prompt.js";
import { createImplementationWorkerProfile } from "../src/core/agent-task/profile.js";
import { FileHistoryService } from "../src/core/file-history/service.js";
import { ProjectService } from "../src/core/project/service.js";
import { ThreadRuntime } from "../src/core/runtime/thread-runtime.js";
import type { ThreadRuntimeOptions } from "../src/core/runtime/options.js";
import type { SessionTreeRecord } from "../src/core/session-tree/model.js";
import { SessionTreeRepository } from "../src/core/session-tree/repository.js";
import { SessionTreeService } from "../src/core/session-tree/service.js";
import { writeTool } from "../src/core/tools/builtins.js";
import type { ToolContext } from "../src/core/tools/types.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function writingModel(): ModelClient {
  return {
    providerId: "test", modelId: "checkpoint-test", contextWindow: 128_000, maxOutputTokens: 8_192,
    async stream(context) {
      const last = context.messages.at(-1);
      return last?.role === "user"
        ? fauxAssistantMessage([fauxToolCall("write", { path: "file.txt", content: last.content }, { id: "write-file" })], { stopReason: "toolUse" })
        : fauxAssistantMessage(fauxText("done"));
    },
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-runtime-checkpoints-"));
  const rootPath = path.join(directory, "project");
  const stateDirectory = path.join(directory, "state");
  await mkdir(rootPath);
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  const options: ThreadRuntimeOptions = { rootPath, stateDirectory, tools: [writeTool], model: writingModel() };
  return { directory, rootPath, stateDirectory, options, file: path.join(rootPath, "file.txt") };
}

test("the runtime defaults to no file checkpoints while persisting turns and supporting conversation rewind", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, "original");
  let runtime = await ThreadRuntime.open(f.options);
  const sessionId = runtime.initialSessionId;
  try {
    const result = await runtime.prompt(sessionId, "changed without backup");
    assert.equal(result.outcome, "completed");
    assert.equal(result.turn.fileCheckpoints, false);
    assert.equal(await readFile(f.file, "utf8"), "changed without backup");
    assert.ok(!runtime.readSession(sessionId).entries.some((entry) => entry.type === "file_edit"));
    await assert.rejects(stat(path.join(f.stateDirectory, "file-history")), { code: "ENOENT" });
    await runtime.close();
    runtime = await ThreadRuntime.open(f.options);
    assert.equal(runtime.readSession(sessionId).turns[0]?.fileCheckpoints, false);
    await assert.rejects(runtime.rewind(sessionId, result.turn.id, { restoreFiles: true }), /checkpoints.*disabled/i);
    assert.equal(runtime.readSession(sessionId).liveTipTurnId, result.turn.id);
    assert.equal(await readFile(f.file, "utf8"), "changed without backup");
    await runtime.rewind(sessionId, result.turn.id);
    assert.equal(runtime.readSession(sessionId).liveTipTurnId, null);
    assert.equal(await readFile(f.file, "utf8"), "changed without backup");
    assert.equal(runtime.readHistory().turns.length, 1);
  } finally {
    await runtime.close();
  }
});

test("enabled checkpoints restore files by default and permit an explicit conversation-only rewind", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, "original");
  const runtime = await ThreadRuntime.open({ ...f.options, fileCheckpoints: true });
  const sessionId = runtime.initialSessionId;
  try {
    const first = await runtime.prompt(sessionId, "first edit");
    assert.equal(first.outcome, "completed");
    assert.equal(first.turn.fileCheckpoints, true);
    assert.equal(runtime.readSession(sessionId).entries.filter((entry) => entry.type === "file_edit").length, 1);
    await runtime.rewind(sessionId, first.turn.id);
    assert.equal(await readFile(f.file, "utf8"), "original");
    const second = await runtime.prompt(sessionId, "second edit");
    const entries = runtime.readHistory().entries;
    await runtime.rewind(sessionId, second.turn.id, { restoreFiles: false });
    assert.equal(runtime.readSession(sessionId).liveTipTurnId, null);
    assert.equal(await readFile(f.file, "utf8"), "second edit");
    assert.deepEqual(runtime.readHistory().entries, entries);
  } finally {
    await runtime.close();
  }
});

test("reopening with checkpoints enabled rejects restoration across a disabled turn before any effects", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, "original");
  let runtime = await ThreadRuntime.open({ ...f.options, fileCheckpoints: true });
  const sessionId = runtime.initialSessionId;
  try {
    const first = await runtime.prompt(sessionId, "tracked first edit");
    await runtime.close();
    runtime = await ThreadRuntime.open({ ...f.options, fileCheckpoints: false });
    const second = await runtime.prompt(sessionId, "untracked second edit");
    await assert.rejects(runtime.rewind(sessionId, first.turn.id, { restoreFiles: true }), /checkpoints.*disabled/i);
    await runtime.close();
    runtime = await ThreadRuntime.open({ ...f.options, fileCheckpoints: true });
    const third = await runtime.prompt(sessionId, "tracked third edit");
    assert.deepEqual(runtime.readSession(sessionId).turns.map((turn) => turn.fileCheckpoints), [true, false, true]);
    const before = runtime.readHistory();
    await assert.rejects(runtime.rewind(sessionId, first.turn.id), /Cannot restore files across turn.*disabled/);
    assert.equal(await readFile(f.file, "utf8"), "tracked third edit");
    assert.deepEqual(runtime.readHistory(), before);
    await runtime.rewind(sessionId, third.turn.id);
    assert.equal(await readFile(f.file, "utf8"), "untracked second edit");
    assert.equal(runtime.readSession(sessionId).liveTipTurnId, second.turn.id);
    await runtime.rewind(sessionId, first.turn.id, { restoreFiles: false });
    assert.equal(await readFile(f.file, "utf8"), "untracked second edit");
    assert.equal(runtime.readSession(sessionId).liveTipTurnId, null);
  } finally {
    await runtime.close();
  }
});

test("legacy persisted turns without a checkpoint flag remain restorable", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, "legacy before-image");
  let runtime = await ThreadRuntime.open({ ...f.options, fileCheckpoints: true });
  const sessionId = runtime.initialSessionId;
  try {
    const result = await runtime.prompt(sessionId, "new contents");
    await runtime.close();
    const eventsPath = path.join(f.stateDirectory, "session-tree", "events.jsonl");
    const records = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as SessionTreeRecord);
    for (const record of records) {
      const events = record.type === "batch" ? record.events : [record];
      for (const event of events) if (event.type === "turn_started") delete event.turn.fileCheckpoints;
    }
    await writeFile(eventsPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    runtime = await ThreadRuntime.open({ ...f.options, fileCheckpoints: true });
    assert.equal(runtime.readSession(sessionId).turns[0]?.fileCheckpoints, undefined);
    await runtime.rewind(sessionId, result.turn.id);
    assert.equal(await readFile(f.file, "utf8"), "legacy before-image");
  } finally {
    await runtime.close();
  }
});

test("workers receive the active checkpoint setting and edit successfully without disabled backups", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, "before worker");
  const workerPrompts: string[] = [];
  let workerCalls = 0;
  const worker: ModelClient = {
    ...writingModel(),
    async stream(context) {
      workerPrompts.push(context.systemPrompt ?? "");
      return ++workerCalls === 1
        ? fauxAssistantMessage(fauxToolCall("write", { path: "file.txt", content: "worker changed it" }, { id: "worker-write" }), { stopReason: "toolUse" })
        : fauxAssistantMessage(fauxText("Edited file.txt."));
    },
  };
  // Direct profile callers keep their previous checkpoint-enabled default.
  assert.ok(createImplementationWorkerProfile(worker).systemPrompt.includes(FILE_EDITING_PROMPT));
  let mainCalls = 0;
  const main: ModelClient = {
    ...writingModel(),
    async stream(context) {
      if (++mainCalls === 1) return fauxAssistantMessage(fauxToolCall("delegate_tasks", { tasks: [{
        title: "Edit file", objective: "Update file.txt", guidance: ["Use the write tool."],
        acceptanceCriteria: ["file.txt contains worker changed it"], writeScope: [{ path: "file.txt", kind: "file" }],
      }] }, { id: "delegate-worker" }), { stopReason: "toolUse" });
      if (mainCalls === 2) {
        const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === "delegate-worker");
        assert.equal(result?.role, "toolResult");
        if (result?.role !== "toolResult") throw new Error("Missing delegation response");
        assert.equal(result.isError, false);
        const payload = JSON.parse(result.content.filter((item) => item.type === "text").map((item) => item.text).join("")) as {
          tasks: Array<{ taskId: string }>;
        };
        return fauxAssistantMessage(fauxToolCall("wait_tasks", {
          taskIds: payload.tasks.map((task) => task.taskId), returnWhen: "all",
        }, { id: "wait-worker" }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(fauxText("Done."));
    },
  };
  const runtime = await ThreadRuntime.open({
    ...f.options, model: main, fileCheckpoints: false,
    implementationWorker: { enabled: true, model: worker },
  });
  try {
    const result = await runtime.prompt(runtime.initialSessionId, "Delegate the file update", { maxSteps: 3, timeoutMs: 10_000 });
    assert.equal(result.outcome, "completed");
    assert.equal(workerCalls, 2);
    assert.ok(workerPrompts.every((prompt) => prompt.includes("File checkpoints are disabled")));
    assert.ok(workerPrompts.every((prompt) => !prompt.includes("Thread records project files") && !prompt.includes("/rewind can restore")));
    assert.equal(await readFile(f.file, "utf8"), "worker changed it");
    const snapshot = runtime.readSession(runtime.initialSessionId);
    assert.equal(snapshot.tasks[0]?.summary.status, "completed");
    assert.ok(!snapshot.entries.some((entry) => entry.type === "file_edit"));
    await assert.rejects(stat(path.join(f.stateDirectory, "file-history")), { code: "ENOENT" });
  } finally {
    await runtime.close();
  }
});

test("disabled capture still shares per-path serialization across turn trackers and refuses inactive turns", async (t) => {
  const f = await fixture(t);
  const project = await ProjectService.open(f.rootPath, { stateDirectory: f.stateDirectory });
  const repository = await SessionTreeRepository.open(project);
  const tree = new SessionTreeService(repository);
  await tree.initialize();
  const files = new FileHistoryService(project, tree, [], false);
  const firstStarted = gate();
  const releaseFirst = gate();
  const order: string[] = [];
  try {
    const turn = await tree.startPlannedTurn(tree.planTurn("coordinated edits", [], tree.activeSession.id, false));
    const main = files.forTurn(turn.id);
    const worker = files.forTurn(turn.id);
    const first = main.track(f.file, async (save) => {
      order.push("main started");
      firstStarted.resolve();
      await releaseFirst.promise;
      await save({ content: Buffer.from("before"), mode: 0o644 });
      order.push("main finished");
    });
    await firstStarted.promise;
    const second = worker.track(f.file, async (save) => {
      order.push("worker started");
      await save(undefined);
    });
    await Promise.resolve();
    assert.deepEqual(order, ["main started"]);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["main started", "main finished", "worker started"]);
    await tree.finishTurn(turn.id, "completed");
    await assert.rejects(worker.track(f.file, async () => { order.push("late edit"); }), /inactive turn/);
    assert.ok(!order.includes("late edit"));
    assert.ok(!tree.entriesForTurn(turn.id).some((entry) => entry.type === "file_edit"));
    await assert.rejects(stat(files.store.blobsPath), { code: "ENOENT" });
  } finally {
    releaseFirst.resolve();
    await files.settle();
    await repository.close();
  }
});

test("disabled file capture retains builtin path checks and cancellation", async (t) => {
  const f = await fixture(t);
  const project = await ProjectService.open(f.rootPath, { stateDirectory: f.stateDirectory });
  const repository = await SessionTreeRepository.open(project);
  const tree = new SessionTreeService(repository);
  await tree.initialize();
  const files = new FileHistoryService(project, tree, [], false);
  try {
    const turn = await tree.startPlannedTurn(tree.planTurn("guard writes", [], tree.activeSession.id, false));
    const controller = new AbortController();
    const context: ToolContext = {
      rootPath: project.rootPath, signal: controller.signal, fileHistory: files.forTurn(turn.id),
      invocation: { executionId: turn.id, assistantEntryId: "assistant", toolCallId: "write" },
    };
    const outside = path.join(f.directory, "outside.txt");
    await writeFile(outside, "private");
    const blocked = await writeTool.execute({ path: outside, content: "bad" }, context);
    assert.equal(blocked.isError, true);
    assert.equal(await readFile(outside, "utf8"), "private");
    await writeFile(f.file, "original");
    controller.abort(new DOMException("Host cancelled", "AbortError"));
    const aborted = await writeTool.execute({ path: "file.txt", content: "bad" }, context);
    assert.equal(aborted.isError, true);
    assert.equal(await readFile(f.file, "utf8"), "original");
    assert.ok(!tree.entriesForTurn(turn.id).some((entry) => entry.type === "file_edit"));
    await tree.finishTurn(turn.id, "interrupted");
  } finally {
    await files.settle();
    await repository.close();
  }
});
