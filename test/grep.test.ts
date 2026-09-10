import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { grepTool } from "../src/core/tools/grep.js";
import { GREP_SCAN_BYTES, GREP_SCAN_CAP, type GrepDetails } from "../src/core/tools/grep-results.js";
import type { ToolContext } from "../src/core/tools/types.js";
import { runProcess } from "../src/core/utils/process.js";
import { executeTool } from "./fixtures/tools.js";
import { fixture } from "./fixtures/runtime.js";

function context(rootPath: string, signal = new AbortController().signal): ToolContext {
  return { rootPath, signal, invocation: { executionId: "e", assistantEntryId: "a", toolCallId: "t" } };
}

test("grep cursor pagination keeps an alias's effective scope and reads context from that scope", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const outside = path.join(f.directory, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "matches.txt"), "before\nneedle first\nmiddle\nneedle second\nafter\n");
  await symlink(outside, path.join(f.rootPath, "alias"), process.platform === "win32" ? "junction" : "dir");
  const query = { pattern: "needle", path: " alias ", limit: 1, context: 1 };
  const first = await executeTool(grepTool, query, context(f.rootPath));
  assert.equal(first.isError, false, first.content);
  assert.match(first.content, /before/);
  const cursor = (first.details as GrepDetails).nextCursor!;
  const second = await executeTool(grepTool, { ...query, cursor }, context(f.rootPath));
  assert.equal(second.isError, false, second.content);
  assert.match(second.content, /needle second/);
  assert.match(second.content, /after/);
  const mismatch = await executeTool(grepTool, { ...query, path: ".", cursor }, context(f.rootPath));
  assert.equal(mismatch.isError, true);
  assert.match(mismatch.content, /cursor does not match/);
});

test("grep returns capped pages from output that previously exceeded 8MB, in both modes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "thread-grep-cap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "matches.txt"), "needle 中文😀\n".repeat(100_000));
  for (const outputMode of ["content", "files"] as const) {
    const result = await executeTool(grepTool, { pattern: "needle", limit: 1, outputMode }, context(root));
    assert.equal(result.isError, false, result.content);
    const details = result.details as GrepDetails;
    assert.equal(details.totalMatches, GREP_SCAN_CAP);
    assert.equal(details.shown, 1);
    assert.equal(details.scanCapped, true);
    assert.match(result.content, /scan capped/);
    if (outputMode === "content") {
      assert.match(result.content, /1: needle 中文😀/);
      assert.ok(details.nextCursor);
      const next = await executeTool(grepTool, { pattern: "needle", limit: 1, cursor: details.nextCursor }, context(root));
      assert.equal(next.isError, false, next.content);
      assert.match(next.content, /2: needle 中文😀/);
      assert.equal((next.details as GrepDetails).offset, 1);
    }
  }
});

test("grep's byte cap preserves complete matches and identifies incomplete scans", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "thread-grep-bytes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "long.txt"), `needle first\nneedle ${"x".repeat(GREP_SCAN_BYTES)}\n`);
  const result = await executeTool(grepTool, { pattern: "needle" }, context(root));
  assert.equal(result.isError, false, result.content);
  assert.match(result.content, /needle first/);
  assert.match(result.content, /8MB/);
  assert.equal((result.details as GrepDetails).scanCapped, true);
  assert.equal((result.details as GrepDetails).totalMatches, 1);
});

test("grep distinguishes empty results, regex errors, and cancellation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "thread-grep-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "sample.txt"), "中文😀 needle\nsecond line\n");
  const small = await executeTool(grepTool, { pattern: "needle" }, context(root));
  assert.equal(small.isError, false);
  assert.match(small.content, /中文😀 needle/);
  assert.equal((small.details as GrepDetails).scanCapped, false);
  const empty = await executeTool(grepTool, { pattern: "absent" }, context(root));
  assert.equal(empty.isError, false);
  assert.equal(empty.content, "No matches found.");
  const invalid = await executeTool(grepTool, { pattern: "[" }, context(root));
  assert.equal(invalid.isError, true);
  assert.match(invalid.content, /regex|unclosed/i);
  const aborted = await executeTool(grepTool, { pattern: "needle" }, context(root, AbortSignal.abort(new Error("cancelled by user"))));
  assert.equal(aborted.isError, true);
  assert.match(aborted.content, /cancelled by user/);
});

test("streamed process output can stop a running process without buffering stdout", async () => {
  const stop = new AbortController();
  let received = "";
  const result = await runProcess(process.execPath, ["-e", 'setInterval(() => process.stdout.write("ready\\n"), 10)'], {
    signal: AbortSignal.any([stop.signal, AbortSignal.timeout(5_000)]),
    allowExitCodes: "any",
    onStdout(chunk) { received += chunk.toString(); stop.abort(); },
  });
  assert.match(received, /ready/);
  assert.equal(result.stdout.length, 0);
  assert.equal(result.killedBySignal, true);
});

test("a streaming consumer error rejects the process call", async () => {
  await assert.rejects(runProcess(process.execPath, ["-e", 'process.stdout.write("ready")'], {
    onStdout() { throw new Error("consumer failed"); },
  }), /consumer failed/);
});
