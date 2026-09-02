import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeTool } from "../src/tools/builtins.js";
import { editTool } from "../src/tools/edit.js";
import { workspacePathClaim } from "../src/tools/execution.js";
import { grepFilePath, grepTool, parseRgMatches } from "../src/tools/grep.js";
import { listTool } from "../src/tools/list.js";
import { resolveWorkspacePath } from "../src/tools/path-safety.js";
import { readTool } from "../src/tools/read.js";
import type { ToolContext } from "../src/tools/types.js";

async function fixture(prefix: string): Promise<{
  root: string;
  outsideDir: string;
  outsideFile: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const root = path.join(directory, "project");
  const outsideDir = path.join(directory, "outside");
  const outsideFile = path.join(outsideDir, "notes.txt");
  await mkdir(root, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(outsideFile, "alpha\noutside-token\nomega\n", "utf8");
  await writeFile(path.join(root, "inside.txt"), "inside-token\n", "utf8");
  return {
    root,
    outsideDir,
    outsideFile,
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

function context(rootPath: string): ToolContext {
  return {
    rootPath,
    signal: new AbortController().signal,
    invocation: { executionId: "e", assistantEntryId: "a", toolCallId: "t" },
  };
}

test("resolveWorkspacePath keeps writes inside the project and lets reads leave it", async (t) => {
  const values = await fixture("thread-path-safety-");
  t.after(values.cleanup);

  await assert.rejects(resolveWorkspacePath(values.root, values.outsideFile), /outside workspace/);
  await assert.rejects(resolveWorkspacePath(values.root, "../outside/notes.txt"), /outside workspace/);
  await assert.rejects(
    resolveWorkspacePath(values.root, values.outsideFile, { forWrite: true }),
    /outside workspace/,
  );

  async function sameFile(left: string, right: string): Promise<void> {
    assert.equal(await realpath(left), await realpath(right));
  }
  await sameFile(await resolveWorkspacePath(values.root, values.outsideFile, { allowOutside: true }), values.outsideFile);
  await sameFile(
    await resolveWorkspacePath(values.root, "../outside/notes.txt", { allowOutside: true }),
    values.outsideFile,
  );
  await sameFile(
    await resolveWorkspacePath(values.root, "inside.txt", { allowOutside: true }),
    path.join(values.root, "inside.txt"),
  );
});

test("read, list, and grep can inspect paths outside the project", async (t) => {
  const values = await fixture("thread-path-read-");
  t.after(values.cleanup);
  const ctx = context(values.root);

  const read = await readTool.execute({ path: values.outsideFile }, ctx);
  assert.equal(read.isError, false, read.content);
  assert.match(read.content, /outside-token/);

  const relativeRead = await readTool.execute({ path: "../outside/notes.txt" }, ctx);
  assert.equal(relativeRead.isError, false, relativeRead.content);
  assert.match(relativeRead.content, /outside-token/);

  const listed = await listTool.execute({ path: values.outsideDir }, ctx);
  assert.equal(listed.isError, false, listed.content);
  assert.match(listed.content, /notes\.txt/);

  await workspacePathClaim(values.root, values.outsideFile, "read", { allowOutside: true });

  const grep = await grepTool.execute({ pattern: "outside-token", path: values.outsideFile, literal: true }, ctx);
  assert.equal(grep.isError, false, grep.content);
  assert.match(grep.content, /outside-token/);
  assert.match(grep.content, /notes\.txt/);
});

test("write and edit still refuse paths outside the project", async (t) => {
  const values = await fixture("thread-path-write-");
  t.after(values.cleanup);
  const ctx = context(values.root);

  const written = await writeTool.execute({ path: values.outsideFile, content: "nope" }, ctx);
  assert.equal(written.isError, true);
  assert.match(written.content, /outside workspace/);

  const edited = await editTool.execute(
    { path: values.outsideFile, oldText: "alpha", newText: "beta" },
    ctx,
  );
  assert.equal(edited.isError, true);
  assert.match(edited.content, /outside workspace/);
});

test("grep keeps matches from files outside the project", () => {
  const root = path.join(path.parse(process.cwd()).root, "workspace");
  const outside = path.join(path.parse(process.cwd()).root, "tmp", "notes.txt");
  const parsed = parseRgMatches(
    `${JSON.stringify({
      type: "match",
      data: { path: { text: outside }, line_number: 2, lines: { text: "outside-token" } },
    })}\n`,
    root,
  );
  assert.deepEqual(parsed.matches, [{ file: outside, line: 2, text: "outside-token" }]);
  assert.equal(grepFilePath(root, path.join(root, "src", "read.ts")), "src/read.ts");
});
