import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverGitWorkspace } from "../../src/workspace/discovery.js";
import { runGit } from "../../src/workspace/git.js";
import { SidecarWorkspaceStore } from "../../src/workspace/sidecar-store.js";
import { addGitlink, commitAll, initRepository } from "../helpers/git-fixture.js";

test("independent sidecar snapshots remain self-contained across main-repo GC", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-sidecar-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "main");
  await initRepository(root);
  await writeFile(path.join(root, ".gitignore"), "ignored.log\ntracked-ignored.txt\n");
  await writeFile(path.join(root, ".gitattributes"), "*.txt text eol=lf\n");
  await writeFile(path.join(root, "tracked.txt"), "line one\r\nline two\r\n");
  await writeFile(path.join(root, "tracked-ignored.txt"), "tracked despite ignore\n");
  await runGit(["-C", root, "add", "-A"]);
  await runGit(["-C", root, "add", "-f", "tracked-ignored.txt"]);
  await runGit(["-C", root, "commit", "-m", "initial"]);
  await writeFile(path.join(root, "untracked.txt"), "untracked\n");
  await writeFile(path.join(root, "ignored.log"), "must not snapshot\n");
  await addGitlink(root, "submodule");

  let symlinkCreated = false;
  try {
    await symlink("tracked.txt", path.join(root, "tracked-link.txt"), "file");
    symlinkCreated = (await lstat(path.join(root, "tracked-link.txt"))).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
  }

  const workspace = await discoverGitWorkspace(root);
  const store = new SidecarWorkspaceStore({ workspace, sessionId: "phase0" });
  const first = await store.capture();
  await store.updateKeepRef(first.retentionCommitOid);
  const firstEntries = await store.listTree(first.treeOid);
  const firstPaths = new Set(firstEntries.map((entry) => entry.path));
  assert.ok(firstPaths.has("tracked.txt"));
  assert.ok(firstPaths.has("tracked-ignored.txt"));
  assert.ok(firstPaths.has("untracked.txt"));
  assert.ok(firstPaths.has("submodule"));
  assert.equal(firstPaths.has("ignored.log"), false);
  if (symlinkCreated) assert.ok(firstPaths.has("tracked-link.txt"));
  assert.equal(firstEntries.find((entry) => entry.path === "submodule")?.mode, "160000");

  await rename(path.join(root, "tracked.txt"), path.join(root, "renamed.txt"));
  await rm(path.join(root, "untracked.txt"));
  await writeFile(path.join(root, "new.txt"), "new\n");
  const second = await store.capture(first.retentionCommitOid);
  await store.updateKeepRef(second.retentionCommitOid, first.retentionCommitOid);
  const diff = await store.diffNameStatus(first.treeOid, second.treeOid);
  assert.ok(diff.some((value) => value.startsWith("R") || value === "tracked.txt"));
  assert.ok(diff.includes("new.txt"));

  const restore = await store.restoreTree(second.treeOid, first.treeOid);
  assert.equal(restore.collisions.length, 0);
  assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "line one\nline two\n");
  assert.equal(await readFile(path.join(root, "ignored.log"), "utf8"), "must not snapshot\n");
  const restored = await store.capture(second.retentionCommitOid);
  assert.equal(restored.treeOid, first.treeOid);
  await store.updateKeepRef(restored.retentionCommitOid, second.retentionCommitOid);

  const materialized = path.join(fixture, "materialized");
  await store.materialize(first.treeOid, materialized);
  assert.equal(await readFile(path.join(materialized, "tracked.txt"), "utf8"), "line one\nline two\n");
  assert.equal(await readFile(path.join(materialized, "untracked.txt"), "utf8"), "untracked\n");
  await assert.rejects(readFile(path.join(materialized, "ignored.log"), "utf8"));

  await commitAll(root, "rewrite candidate");
  await runGit(["-C", root, "repack", "-Ad"]);
  await runGit(["-C", root, "reflog", "expire", "--expire=now", "--all"]);
  await runGit(["-C", root, "gc", "--aggressive", "--prune=now"]);
  const mainObjects = path.join(workspace.gitCommonDir, "objects");
  const hiddenMainObjects = path.join(workspace.gitCommonDir, "objects.hidden-for-test");
  await rename(mainObjects, hiddenMainObjects);
  try {
    await store.gc();
    await store.verifySnapshot(first.treeOid, first.retentionCommitOid);
    await store.verifySnapshot(second.treeOid, second.retentionCommitOid);
    const afterGc = path.join(fixture, "after-gc");
    await store.materialize(first.treeOid, afterGc);
    assert.equal(await readFile(path.join(afterGc, "tracked-ignored.txt"), "utf8"), "tracked despite ignore\n");
  } finally {
    await rename(hiddenMainObjects, mainObjects);
  }
});

test("sidecar three-way merge reports clean and conflicting trees without touching worktree", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-merge-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "main");
  await initRepository(root);
  await writeFile(path.join(root, "value.txt"), "base\n");
  await commitAll(root, "base");
  const workspace = await discoverGitWorkspace(root);
  const store = new SidecarWorkspaceStore({ workspace, sessionId: "merge" });
  const base = await store.capture();
  await writeFile(path.join(root, "ours.txt"), "ours\n");
  const ours = await store.capture(base.retentionCommitOid);
  await rm(path.join(root, "ours.txt"));
  await writeFile(path.join(root, "theirs.txt"), "theirs\n");
  const theirs = await store.capture(ours.retentionCommitOid);
  const clean = await store.mergeTrees(base.treeOid, ours.treeOid, theirs.treeOid);
  assert.equal(clean.clean, true);
  assert.ok(clean.treeOid);
  assert.equal(await readFile(path.join(root, "theirs.txt"), "utf8"), "theirs\n");

  await writeFile(path.join(root, "value.txt"), "theirs change\n");
  const theirsConflict = await store.capture(theirs.retentionCommitOid);
  await writeFile(path.join(root, "value.txt"), "ours change\n");
  const oursConflict = await store.capture(theirsConflict.retentionCommitOid);
  const conflict = await store.mergeTrees(base.treeOid, oursConflict.treeOid, theirsConflict.treeOid);
  assert.equal(conflict.clean, false);
  assert.deepEqual(conflict.conflicts, ["value.txt"]);
  assert.equal(await readFile(path.join(root, "value.txt"), "utf8"), "ours change\n");
});
