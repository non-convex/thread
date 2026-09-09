import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeTool } from "../src/core/tools/builtins.js";
import { editTool } from "../src/core/tools/edit.js";
import type { ToolContext } from "../src/core/tools/types.js";

async function fixture() {
  const rootPath = await mkdtemp(path.join(tmpdir(), "thread-write-scope-"));
  const context: ToolContext = { rootPath, signal: new AbortController().signal,
    invocation: { executionId: "turn", assistantEntryId: "assistant", toolCallId: "write" } };
  return { rootPath, context, cleanup: () => rm(rootPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) };
}

test("file scope refuses sibling writes and edits before backups or directory creation", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await writeFile(path.join(f.rootPath, "allowed.txt"), "original");
  await writeFile(path.join(f.rootPath, "other.txt"), "private");
  let tracked = 0;
  f.context.writeScope = [{ path: "allowed.txt", kind: "file" }];
  f.context.fileHistory = { async track(_path, operation) { tracked++; return operation(async () => {}); } };
  const write = await writeTool.execute({ path: "new-directory/other.txt", content: "bad" }, f.context);
  const edit = await editTool.execute({ path: "other.txt", oldText: "private", newText: "bad" }, f.context);
  assert.ok(write.isError && edit.isError);
  assert.match(write.content, /outside the declared write scope/);
  assert.equal(tracked, 0);
  await assert.rejects(stat(path.join(f.rootPath, "new-directory")), { code: "ENOENT" });
  assert.equal(await readFile(path.join(f.rootPath, "other.txt"), "utf8"), "private");
  assert.equal((await writeTool.execute({ path: "./allowed.txt", content: "updated" }, f.context)).isError, false);
  assert.equal((await editTool.execute({ path: "allowed.txt", oldText: "updated", newText: "finished" }, f.context)).isError, false);
  assert.equal(await readFile(path.join(f.rootPath, "allowed.txt"), "utf8"), "finished");
});

test("directory scope uses path boundaries; empty scope denies while an omitted scope preserves main-agent writes", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.context.writeScope = [{ path: "src", kind: "directory" }];
  assert.equal((await writeTool.execute({ path: "src/new/file.txt", content: "allowed" }, f.context)).isError, false);
  for (const target of ["src-other/file.txt", "src/../outside.txt"]) {
    assert.equal((await writeTool.execute({ path: target, content: "bad" }, f.context)).isError, true);
  }
  f.context.writeScope = [];
  assert.equal((await writeTool.execute({ path: "src/new/file.txt", content: "bad" }, f.context)).isError, true);
  delete f.context.writeScope;
  assert.equal((await writeTool.execute({ path: "main.txt", content: "main" }, f.context)).isError, false);
});

test("scope comparison respects platform case rules and resolves directory aliases", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  f.context.writeScope = [{ path: "UPPER.txt", kind: "file" }];
  assert.equal((await writeTool.execute({ path: "upper.txt", content: "case" }, f.context)).isError, process.platform !== "win32");
  await mkdir(path.join(f.rootPath, "allowed"));
  await mkdir(path.join(f.rootPath, "other"));
  await symlink(path.join(f.rootPath, "other"), path.join(f.rootPath, "allowed", "alias"), process.platform === "win32" ? "junction" : "dir");
  f.context.writeScope = [{ path: "allowed", kind: "directory" }];
  const result = await writeTool.execute({ path: "allowed/alias/file.txt", content: "bad" }, f.context);
  assert.equal(result.isError, true);
  assert.match(result.content, /outside the declared write scope/);
  await assert.rejects(stat(path.join(f.rootPath, "other", "file.txt")), { code: "ENOENT" });
});

test("a queued file write rechecks a directory replaced with a junction before touching files", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const pending = path.join(f.rootPath, "allowed", "pending");
  const outside = path.join(f.rootPath, "other");
  await mkdir(pending, { recursive: true });
  await mkdir(outside);
  let saves = 0;
  f.context.writeScope = [{ path: "allowed", kind: "directory" }];
  f.context.fileHistory = { async track(_path, operation) {
    await rename(pending, path.join(f.rootPath, "allowed", "moved"));
    await symlink(outside, pending, process.platform === "win32" ? "junction" : "dir");
    return operation(async () => { saves++; });
  } };
  const result = await writeTool.execute({ path: "allowed/pending/file.txt", content: "bad" }, f.context);
  assert.equal(result.isError, true);
  assert.equal(saves, 0);
  await assert.rejects(stat(path.join(outside, "file.txt")), { code: "ENOENT" });
});
