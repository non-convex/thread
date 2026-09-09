import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { spyOn } from "bun:test";
import { fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { ThreadApp, type ThreadAppOptions } from "../src/app/thread-app.js";
import type { ModelClient, ModelRequestOptions } from "../src/core/agent/model-client.js";
import { ContextBuilder } from "../src/core/context/builder.js";
import { extractDocuments } from "../src/core/session-recall/documents.js";
import { readTurn } from "../src/core/session-recall/reader.js";
import type { FileEditEntry } from "../src/core/session-tree/model.js";
import { writeTool } from "../src/core/tools/builtins.js";
import { editTool } from "../src/core/tools/edit.js";
import { isPathInside, resolveWorkspacePath } from "../src/core/tools/path-safety.js";
import type { ToolContext } from "../src/core/tools/types.js";
import { projectTranscript } from "../src/ui/terminal/transcript-projection.js";
import { FILE_EDITING_PROMPT } from "../src/core/tools/file-editing-prompt.js";
import { IMPLEMENTATION_WORKER_SYSTEM_PROMPT } from "../src/core/agent-task/prompt.js";

function model(stream: (context: Context, options: ModelRequestOptions) => Promise<AssistantMessage>): ModelClient {
  return { modelId: "file-history-test", providerId: "test", contextWindow: 128_000, maxOutputTokens: 8_192, reasoning: false, stream };
}

async function fixture(t: TestContext, options: Pick<ThreadAppOptions, "model" | "implementationWorker"> = {}) {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "thread-file-history-"));
  const root = path.join(directory, "project");
  const home = path.join(directory, "thread-home");
  await fs.mkdir(root);
  const previousHome = process.env.THREAD_HOME;
  process.env.THREAD_HOME = home;
  const runtimeOptions = {
    ...options, rootPath: root, search: { semantic: false },
    tools: ["read", "list", "grep", "write", "edit", "bash"] as const,
    fileCheckpoints: true, systemPrompt: FILE_EDITING_PROMPT,
  };
  let app = await ThreadApp.open(runtimeOptions);
  t.after(async () => {
    await app.close().catch(() => undefined);
    if (previousHome === undefined) delete process.env.THREAD_HOME;
    else process.env.THREAD_HOME = previousHome;
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  return {
    root, home, get app() { return app; },
    // Fault injection targets persistence services, not the application API.
    get tree() { return app.runtime["tree"]; },
    get files() { return app.runtime["files"]; },
    get tasks() { return app.runtime["tasks"]; },
    async reopen() {
      await app.close();
      app = await ThreadApp.open(runtimeOptions);
    },
    async turn() {
      const turn = await app.runtime["tree"].startTurn("change files");
      const context: ToolContext = {
        rootPath: root,
        signal: new AbortController().signal,
        invocation: { executionId: turn.id, assistantEntryId: "assistant", toolCallId: "tool" },
        fileHistory: app.runtime["files"].forTurn(turn.id),
      };
      return {
        id: turn.id, context,
        async write(file: string, content: string) {
          const result = await writeTool.execute({ path: file, content }, context);
          assert.equal(result.isError, false, result.content);
        },
        async edit(file: string, oldText: string, newText: string) {
          const result = await editTool.execute({ path: file, oldText, newText }, context);
          assert.equal(result.isError, false, result.content);
        },
        finish: () => app.runtime["tree"].finishTurn(turn.id, "completed"),
      };
    },
    records(turnId: string) {
      return app.runtime["tree"].entriesForTurn(turnId).filter((entry): entry is FileEditEntry => entry.type === "file_edit");
    },
  };
}

test("edits save only their target, once per turn, preserving original bytes", async (t) => {
  const f = await fixture(t);
  const original = Buffer.from("\ufefffirst\r\nsecond\r\n");
  await fs.writeFile(path.join(f.root, "source.txt"), original);
  await fs.mkdir(path.join(f.root, "unrelated"));
  await Promise.all(Array.from({ length: 250 }, (_, index) => fs.writeFile(path.join(f.root, "unrelated", `${index}.dat`), "unrelated")));
  const turn = await f.turn();
  const originalRead = fs.readFile;
  const originalList = fs.readdir;
  const readSpy = spyOn(fs, "readFile").mockImplementation((...args: any[]) => {
    assert.ok(!String(args[0]).includes(`${path.sep}unrelated${path.sep}`), "must not read unrelated files");
    return (originalRead as any)(...args);
  });
  const listSpy = spyOn(fs, "readdir").mockImplementation((...args: any[]) => {
    assert.ok(!isPathInside(f.root, String(args[0])), "must not enumerate the workspace");
    return (originalList as any)(...args);
  });
  try {
    await turn.edit("source.txt", "first\nsecond", "first\nchanged");
    await turn.write("source.txt", "replacement");
    await turn.finish();
    assert.equal(f.records(turn.id).length, 1);
    await f.app.runtime.rewind(f.tree.activeSession.id, turn.id);
    assert.deepEqual(await fs.readFile(path.join(f.root, "source.txt")), original);
  } finally {
    readSpy.mockRestore();
    listSpy.mockRestore();
  }
});

test("no-op writes, invalid edits, and turns without built-in edits produce no backups", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "same.txt"), "same");
  const turn = await f.turn();
  await turn.write("same.txt", "same");
  const invalid = await editTool.execute({ path: "same.txt", oldText: "missing", newText: "next" }, turn.context);
  assert.equal(invalid.isError, true);
  await fs.writeFile(path.join(f.root, "external.txt"), "untracked");
  await turn.finish();
  assert.deepEqual(f.records(turn.id), []);
  await assert.rejects(fs.stat(f.files.store.blobsPath), { code: "ENOENT" });
  await f.app.runtime.rewind(f.tree.activeSession.id, turn.id);
  assert.equal(await fs.readFile(path.join(f.root, "external.txt"), "utf8"), "untracked");
  assert.equal(f.tree.activeLiveTip, null);
});

test("rewind spans turns, directly overwrites external changes, and retains other files and branches", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "file.txt"), "A");
  const first = await f.turn();
  await first.write("file.txt", "B");
  await first.write("nested/new.txt", "created");
  await first.finish();
  await fs.writeFile(path.join(f.root, "file.txt"), "manual before second turn");
  const second = await f.turn();
  await second.write("file.txt", "C");
  await second.write("nested/new.txt", "updated");
  await second.finish();
  await fs.writeFile(path.join(f.root, "file.txt"), "manual after turn");
  await fs.writeFile(path.join(f.root, "untracked.txt"), "keep");
  await f.app.runtime.rewind(f.tree.activeSession.id, first.id);
  assert.equal(await fs.readFile(path.join(f.root, "file.txt"), "utf8"), "A");
  await assert.rejects(fs.stat(path.join(f.root, "nested/new.txt")), { code: "ENOENT" });
  assert.ok((await fs.stat(path.join(f.root, "nested"))).isDirectory());
  assert.equal(await fs.readFile(path.join(f.root, "untracked.txt"), "utf8"), "keep");
  const branch = await f.turn();
  await branch.write("file.txt", "branch");
  await branch.finish();
  assert.ok(f.tree.projection.turns.has(second.id));
  assert.deepEqual(f.tree.livePath().map((turn) => turn.id), [branch.id]);
  await f.app.runtime.rewind(f.tree.activeSession.id, branch.id);
  assert.equal(await fs.readFile(path.join(f.root, "file.txt"), "utf8"), "A");
});

test("rewind to a later turn uses that turn's first edit state", async (t) => {
  const f = await fixture(t);
  const first = await f.turn();
  await first.write("file.txt", "first");
  await first.finish();
  await fs.writeFile(path.join(f.root, "file.txt"), "idle edit");
  const second = await f.turn();
  await second.write("file.txt", "second");
  await second.finish();
  await f.app.runtime.rewind(f.tree.activeSession.id, second.id);
  assert.equal(await fs.readFile(path.join(f.root, "file.txt"), "utf8"), "idle edit");
  assert.equal(f.tree.activeLiveTip, first.id);
});

test("write backups preserve binary bytes and explicitly edited ignored files", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "node_modules"));
  await fs.writeFile(path.join(f.root, ".gitignore"), ".env\nnode_modules/\n");
  const binary = Buffer.from([0, 255, 128, 13, 10]);
  await fs.writeFile(path.join(f.root, "node_modules", "data.bin"), binary);
  const turn = await f.turn();
  await turn.write("node_modules/data.bin", "replaced");
  await turn.write(".env", "local");
  await turn.finish();
  assert.equal(f.records(turn.id).length, 2);
  await f.app.runtime.rewind(f.tree.activeSession.id, turn.id);
  assert.deepEqual(await fs.readFile(path.join(f.root, "node_modules", "data.bin")), binary);
  await assert.rejects(fs.stat(path.join(f.root, ".env")), { code: "ENOENT" });
});

test("backup and journal failures stop the write and leave collectible orphan blobs", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "file.txt"), "before");
  const turn = await f.turn();
  const storeFailure = spyOn(f.files.store, "put").mockRejectedValue(new Error("backup failed"));
  try {
    const result = await writeTool.execute({ path: "file.txt", content: "after" }, turn.context);
    assert.equal(result.isError, true);
    assert.match(result.content, /backup failed/);
    assert.equal(await fs.readFile(path.join(f.root, "file.txt"), "utf8"), "before");
  } finally { storeFailure.mockRestore(); }
  const journalFailure = spyOn(f.tree, "appendFileEdit").mockRejectedValue(new Error("journal failed"));
  try {
    const result = await writeTool.execute({ path: "file.txt", content: "after" }, turn.context);
    assert.equal(result.isError, true);
    assert.match(result.content, /journal failed/);
    assert.equal(await fs.readFile(path.join(f.root, "file.txt"), "utf8"), "before");
  } finally { journalFailure.mockRestore(); }
  await turn.finish();
  assert.deepEqual(f.records(turn.id), []);
  assert.deepEqual(await f.app.runtime.cleanupFileHistory(), { blobsRemoved: 1 });
});

test("missing or corrupt backups stop rewind before changing any file or live tip", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "one.txt"), "one");
  await fs.writeFile(path.join(f.root, "two.txt"), "two");
  const turn = await f.turn();
  await turn.write("one.txt", "changed one");
  await turn.write("two.txt", "changed two");
  await turn.finish();
  const record = f.records(turn.id).find((entry) => entry.path === "two.txt")!;
  const blob = f.files.store.blobPath(record.before!.blobId);
  await fs.writeFile(blob, "corrupt");
  await assert.rejects(f.app.runtime.rewind(f.tree.activeSession.id, turn.id), /corrupt/);
  assert.equal(await fs.readFile(path.join(f.root, "one.txt"), "utf8"), "changed one");
  assert.equal(f.tree.activeLiveTip, turn.id);
  await fs.rm(blob);
  await assert.rejects(f.app.runtime.rewind(f.tree.activeSession.id, turn.id), { code: "ENOENT" });
  assert.equal(f.tree.activeLiveTip, turn.id);
  await fs.writeFile(blob, "two");
  await f.app.runtime.rewind(f.tree.activeSession.id, turn.id);
  assert.equal(await fs.readFile(path.join(f.root, "one.txt"), "utf8"), "one");
});

test("unfinished edits survive restart and can be rewound", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "file.txt"), "original");
  const turn = await f.turn();
  await turn.write("file.txt", "partial");
  await f.reopen();
  assert.equal(f.tree.projection.turns.get(turn.id)?.status, "interrupted");
  await f.app.runtime.rewind(f.tree.activeSession.id, turn.id);
  assert.equal(await fs.readFile(path.join(f.root, "file.txt"), "utf8"), "original");
});

test("file history is excluded from context, recall and transcript; GC keeps every session and branch", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "file.txt"), "private-before-image-token");
  const turn = await f.turn();
  await turn.write("file.txt", "updated");
  await turn.finish();
  const entries = f.tree.entriesForTurn(turn.id);
  assert.equal(projectTranscript(entries).length, 1);
  assert.equal(extractDocuments(entries).length, 1);
  assert.doesNotMatch(JSON.stringify(new ContextBuilder(f.tree).build()), /blobId|file_edit|private-before-image-token/);
  assert.doesNotMatch(JSON.stringify(readTurn(f.tree, turn.id, { toolCalls: true, toolResults: true })), /blobId|file_edit|private-before-image-token/);
  await f.app.runtime.rewind(f.tree.activeSession.id, turn.id);
  await f.tree.createSession();
  const other = await f.turn();
  await other.write("file.txt", "other session");
  await other.finish();
  assert.deepEqual(await f.app.runtime.cleanupFileHistory(), { blobsRemoved: 0 });
  await f.tree.openSession(f.tree.projection.turns.get(turn.id)!.sessionId);
  assert.equal(await fs.readFile(path.join(f.root, "file.txt"), "utf8"), "other session");
  assert.deepEqual(await f.app.runtime.fsck(), []);
});

test("concurrent editors share a first-write record and distinct files retain ordered tree entries", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "file.txt"), "original");
  const turn = await f.turn();
  await Promise.all([
    turn.write("file.txt", "one"), turn.write("file.txt", "two"),
    ...Array.from({ length: 12 }, (_, index) => turn.write(`parallel-${index}.txt`, String(index))),
    f.tree.appendMessage({ turnId: turn.id, message: { role: "user", content: "parallel metadata", timestamp: Date.now() } }, true),
  ]);
  assert.equal(f.records(turn.id).filter((entry) => entry.path === "file.txt").length, 1);
  assert.equal(f.records(turn.id).length, 13);
  await turn.finish();
  await f.reopen();
  await f.app.runtime.rewind(f.tree.activeSession.id, turn.id);
  assert.equal(await fs.readFile(path.join(f.root, "file.txt"), "utf8"), "original");
});

test("rewind refuses directory targets without recursive deletion", async (t) => {
  const f = await fixture(t);
  const turn = await f.turn();
  await turn.write("new.txt", "created");
  await turn.finish();
  await fs.rm(path.join(f.root, "new.txt"));
  await fs.mkdir(path.join(f.root, "new.txt"));
  await fs.writeFile(path.join(f.root, "new.txt", "keep.txt"), "keep");
  await assert.rejects(f.app.runtime.rewind(f.tree.activeSession.id, turn.id), /not a regular file/);
  assert.equal(await fs.readFile(path.join(f.root, "new.txt", "keep.txt"), "utf8"), "keep");
  assert.equal(f.tree.activeLiveTip, turn.id);
});

test("global memory and Thread state writes stay outside project history", async (t) => {
  const f = await fixture(t);
  const turn = await f.turn();
  const memory = path.join(f.home, ".THREAD.md");
  const result = await writeTool.execute({ path: memory, content: "global fact" }, {
    ...turn.context, writableExternalPaths: [memory],
  });
  assert.equal(result.isError, false, result.content);
  await turn.finish();
  assert.deepEqual(f.records(turn.id), []);
  await f.app.runtime.rewind(f.tree.activeSession.id, turn.id);
  assert.equal(await fs.readFile(memory, "utf8"), "global fact");
});

test("disk-root containment permits descendants and still rejects other roots", async (t) => {
  const f = await fixture(t);
  const diskRoot = path.parse(f.root).root;
  assert.ok(isPathInside(diskRoot, f.root));
  assert.equal(await resolveWorkspacePath(diskRoot, path.join(f.root, "future.txt"), { forWrite: true }), path.join(await fs.realpath(f.root), "future.txt"));
  assert.ok(!isPathInside(f.root, `${f.root}-sibling`));
  if (process.platform === "win32") assert.ok(!isPathInside("C:\\", "D:\\file.txt"));
  const app = await ThreadApp.open({ rootPath: diskRoot, search: { semantic: false }, fileCheckpoints: true });
  try {
    const turn = await app.runtime["tree"].startTurn("edit from a volume root");
    const target = path.join(f.root, "root-edit.txt");
    const result = await writeTool.execute({ path: target, content: "created" }, {
      rootPath: diskRoot, signal: new AbortController().signal,
      invocation: { executionId: turn.id, assistantEntryId: "assistant", toolCallId: "write" },
      fileHistory: app.runtime["files"].forTurn(turn.id),
    });
    assert.equal(result.isError, false, result.content);
    const stateWrite = await writeTool.execute({ path: path.join(f.home, "internal.txt"), content: "Thread state" }, {
      rootPath: diskRoot, signal: new AbortController().signal,
      invocation: { executionId: turn.id, assistantEntryId: "assistant", toolCallId: "state-write" },
      fileHistory: app.runtime["files"].forTurn(turn.id),
    });
    assert.equal(stateWrite.isError, false, stateWrite.content);
    await app.runtime["tree"].finishTurn(turn.id, "completed");
    assert.equal(app.runtime["tree"].entriesForTurn(turn.id).filter((entry) => entry.type === "file_edit").length, 1);
    await app.runtime.rewind(app.selectedSessionId, turn.id);
    await assert.rejects(fs.stat(target), { code: "ENOENT" });
  } finally { await app.close(); }
});

test("worker edits and revisions share the parent turn's first backup", async (t) => {
  let calls = 0;
  const worker = model(async () => {
    calls++;
    return calls === 1 || calls === 3
      ? fauxAssistantMessage(fauxToolCall("write", { path: "shared.txt", content: `worker ${calls}` }, { id: `write-${calls}` }), { stopReason: "toolUse" })
      : fauxAssistantMessage(fauxText("done"));
  });
  const f = await fixture(t, { implementationWorker: { enabled: true, model: worker } });
  await fs.writeFile(path.join(f.root, "shared.txt"), "before worker");
  const turn = await f.turn();
  const [task] = await f.tasks.delegate([{
    title: "edit shared file", objective: "edit shared.txt", guidance: ["Use write"],
    acceptanceCriteria: ["file changed"], writeScope: [{ path: "shared.txt", kind: "file" }],
  }], { parentTurnId: turn.id, toolCallId: "delegate", signal: turn.context.signal });
  const [first] = await f.tasks.waitTasks([task!.taskId], "all", turn.context.signal);
  assert.equal(first!.summary.status, "completed", JSON.stringify(first));
  await f.tasks.requestRevision(task!.taskId, "revise the file", turn.context.signal);
  const [revised] = await f.tasks.waitTasks([task!.taskId], "all", turn.context.signal);
  assert.equal(revised!.summary.status, "completed", JSON.stringify(revised));
  await turn.write("shared.txt", "main edit after worker");
  assert.equal(f.records(turn.id).length, 1);
  await turn.finish();
  await f.reopen();
  await f.app.runtime.rewind(f.tree.activeSession.id, turn.id);
  assert.equal(await fs.readFile(path.join(f.root, "shared.txt"), "utf8"), "before worker");
});

test("runtime tracks built-in edits before a failed step and never tracks bash", async (t) => {
  let calls = 0;
  const client = model(async (context) => {
    assert.ok(context.systemPrompt?.includes(FILE_EDITING_PROMPT));
    calls++;
    if (calls === 1) return fauxAssistantMessage(fauxToolCall("bash", {
      command: process.platform === "win32" ? "echo bash-created > bash.txt" : "printf bash-created > bash.txt",
    }, { id: "bash" }), { stopReason: "toolUse" });
    if (calls === 2) return fauxAssistantMessage(fauxText("bash complete"));
    if (calls === 3) return fauxAssistantMessage(fauxToolCall("write", { path: "tracked.txt", content: "changed" }, { id: "tracked" }), { stopReason: "toolUse" });
    throw new Error("model failed after editing");
  });
  const f = await fixture(t, { model: client });
  const signal = new AbortController().signal;
  const bash = await f.app.handleInput("use bash", { signal });
  assert.equal(bash.kind, "turn");
  const bashId = f.tree.activeLiveTip!;
  assert.deepEqual(f.records(bashId), []);
  await assert.rejects(fs.stat(f.files.store.blobsPath), { code: "ENOENT" });
  await fs.writeFile(path.join(f.root, "tracked.txt"), "original");
  const edited = await f.app.handleInput("edit and then fail", { signal });
  assert.ok(edited.kind === "turn" && edited.result.outcome === "failed");
  await f.app.runtime.rewind(f.tree.activeSession.id, bashId);
  assert.equal(await fs.readFile(path.join(f.root, "tracked.txt"), "utf8"), "original");
  assert.match(await fs.readFile(path.join(f.root, "bash.txt"), "utf8"), /bash-created/);
});

test("interrupted worker edits remain attached to the parent turn and survive reopening", async (t) => {
  let markWaiting!: () => void;
  const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
  let calls = 0;
  const worker = model(async (_context, options) => {
    if (++calls === 1) return fauxAssistantMessage(
      fauxToolCall("write", { path: "partial.txt", content: "worker partial" }, { id: "partial" }),
      { stopReason: "toolUse" },
    );
    markWaiting();
    await new Promise<void>((resolve) => {
      if (options.signal.aborted) resolve();
      else options.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return fauxAssistantMessage(fauxText("cancelled"), { stopReason: "aborted" });
  });
  const f = await fixture(t, { implementationWorker: { enabled: true, model: worker } });
  await fs.writeFile(path.join(f.root, "partial.txt"), "before worker");
  const turn = await f.turn();
  await f.tasks.delegate([{
    title: "partial edit", objective: "edit partial.txt", guidance: ["Use write"],
    acceptanceCriteria: ["file changed"], writeScope: [{ path: "partial.txt", kind: "file" }],
  }], { parentTurnId: turn.id, toolCallId: "delegate", signal: turn.context.signal });
  await waiting;
  await f.tasks.finishParentTurn(turn.id, "Parent interrupted");
  await f.tree.finishTurn(turn.id, "interrupted");
  assert.equal(await fs.readFile(path.join(f.root, "partial.txt"), "utf8"), "worker partial");
  assert.equal(f.records(turn.id).length, 1);
  await f.reopen();
  await f.app.runtime.rewind(f.tree.activeSession.id, turn.id);
  assert.equal(await fs.readFile(path.join(f.root, "partial.txt"), "utf8"), "before worker");
});

test("rewind never follows a replacement symlink or restores through an outside parent", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "dir"));
  await fs.writeFile(path.join(f.root, "dir", "file.txt"), "original");
  const turn = await f.turn();
  await turn.write("dir/file.txt", "changed");
  await turn.finish();
  const outside = path.join(f.home, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "file.txt"), "outside");
  await fs.rename(path.join(f.root, "dir"), path.join(f.root, "moved"));
  await fs.symlink(outside, path.join(f.root, "dir"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.app.runtime.rewind(f.tree.activeSession.id, turn.id), /outside workspace/);
  assert.equal(await fs.readFile(path.join(outside, "file.txt"), "utf8"), "outside");
  assert.equal(f.tree.activeLiveTip, turn.id);
});

test("project and tree version 1 are rejected without migration or deletion", async (t) => {
  const f = await fixture(t);
  const projectPath = path.join(f.app.runtime.project.statePath, "project.json");
  const treePath = path.join(f.app.runtime.project.statePath, "session-tree", "tree.json");
  await f.app.close();
  const project = await fs.readFile(projectPath, "utf8");
  const tree = await fs.readFile(treePath, "utf8");
  await fs.writeFile(projectPath, JSON.stringify({ ...JSON.parse(project), format: "thread-project-v1", formatVersion: 1 }));
  await assert.rejects(f.reopen(), /Unsupported Thread project data/);
  assert.equal(JSON.parse(await fs.readFile(projectPath, "utf8")).formatVersion, 1);
  await fs.writeFile(projectPath, project);
  await fs.writeFile(treePath, JSON.stringify({ ...JSON.parse(tree), format: "thread-session-tree-v1", formatVersion: 1 }));
  await assert.rejects(f.reopen(), /Unsupported Session Tree manifest/);
  assert.equal(JSON.parse(await fs.readFile(treePath, "utf8")).formatVersion, 1);
  await fs.writeFile(treePath, tree);
  await f.reopen();
});

test("main and worker share the editing and bash recovery rule", () => {
  assert.match(FILE_EDITING_PROMPT, /bash.*not tracked/);
  assert.ok(IMPLEMENTATION_WORKER_SYSTEM_PROMPT.includes(FILE_EDITING_PROMPT));
});
