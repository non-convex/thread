import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gitBranchName } from "../src/utils/git.js";
import { runProcess } from "../src/utils/process.js";

async function fixture(prefix: string): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const root = path.join(directory, "project");
  await mkdir(root, { recursive: true });
  return { root, cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) };
}

async function git(root: string, args: string[]): Promise<void> {
  await runProcess("git", args, {
    cwd: root,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" },
    allowExitCodes: [0],
  });
}

test("gitBranchName is undefined outside a work tree", async (t) => {
  const values = await fixture("thread-git-none-");
  t.after(values.cleanup);
  assert.equal(await gitBranchName(values.root), undefined);
});

test("gitBranchName reads the current branch", async (t) => {
  const values = await fixture("thread-git-branch-");
  t.after(values.cleanup);
  await git(values.root, ["init"]);
  await git(values.root, ["checkout", "-b", "feature-status"]);
  assert.equal(await gitBranchName(values.root), "feature-status");
});

test("gitBranchName uses a short SHA when HEAD is detached", async (t) => {
  const values = await fixture("thread-git-detached-");
  t.after(values.cleanup);
  await git(values.root, ["init"]);
  await git(values.root, ["config", "user.email", "thread@example.com"]);
  await git(values.root, ["config", "user.name", "Thread"]);
  await writeFile(path.join(values.root, "a.txt"), "a\n");
  await git(values.root, ["add", "a.txt"]);
  await git(values.root, ["commit", "-m", "init"]);
  const sha = await gitBranchName(values.root);
  assert.ok(sha);
  await git(values.root, ["checkout", "--detach"]);
  const detached = await gitBranchName(values.root);
  assert.ok(detached);
  assert.notEqual(detached, "HEAD");
  assert.match(detached!, /^[0-9a-f]{4,40}$/);
});
