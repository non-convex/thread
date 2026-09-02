import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Project } from "../src/project/model.js";
import { WorkspaceStateRepository } from "../src/workspace-state/repository.js";

async function fixture(prefix: string): Promise<{ project: Project; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const rootPath = path.join(directory, "project");
  const statePath = path.join(directory, "thread-state");
  await Promise.all([
    mkdir(rootPath, { recursive: true }),
    mkdir(statePath, { recursive: true }),
  ]);
  return {
    project: { id: "project_workspace_policy_test", rootPath, statePath },
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

test("workspace checkpoints skip common dependency, output, and cache directories at every depth", async (t) => {
  const values = await fixture("thread-workspace-exclusions-");
  t.after(values.cleanup);
  const root = values.project.rootPath;

  await Promise.all([
    mkdir(path.join(root, "node_modules", "package"), { recursive: true }),
    mkdir(path.join(root, "packages", "web", "node_modules", "package"), { recursive: true }),
    mkdir(path.join(root, "packages", "web", "dist"), { recursive: true }),
    mkdir(path.join(root, ".cache"), { recursive: true }),
    mkdir(path.join(root, "generated", "private"), { recursive: true }),
    mkdir(path.join(root, "src"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "node_modules", "package", "index.js"), "dependency\n"),
    writeFile(path.join(root, "packages", "web", "node_modules", "package", "index.js"), "nested dependency\n"),
    writeFile(path.join(root, "packages", "web", "dist", "bundle.js"), "bundle\n"),
    writeFile(path.join(root, ".cache", "result"), "cache\n"),
    writeFile(path.join(root, "generated", "private", "secret.bin"), "generated\n"),
    writeFile(path.join(root, "src", "index.ts"), "original\n"),
    writeFile(path.join(root, ".env"), "TOKEN=local\n"),
  ]);

  const repository = new WorkspaceStateRepository(values.project, { excludedPaths: ["generated/private"] });
  await repository.initialize();
  const state = await repository.capture();
  const paths = new Set(state.entries.map((entry) => entry.path));

  assert.equal(state.formatVersion, 2);
  assert.ok(state.policy.excludedDirectoryNames.includes("node_modules"));
  assert.ok(paths.has("src/index.ts"));
  assert.ok(paths.has(".env"), "other gitignored files remain part of the checkpoint");
  assert.ok(paths.has("packages/web"));
  assert.ok(paths.has("generated"));
  assert.ok(![...paths].some((entry) => entry.split("/").includes("node_modules")));
  assert.ok(![...paths].some((entry) => entry === ".cache" || entry.startsWith(".cache/")));
  assert.ok(![...paths].some((entry) => entry === "packages/web/dist" || entry.startsWith("packages/web/dist/")));
  assert.ok(![...paths].some((entry) => entry === "generated/private" || entry.startsWith("generated/private/")));

  await Promise.all([
    writeFile(path.join(root, "src", "index.ts"), "changed\n"),
    writeFile(path.join(root, "node_modules", "package", "index.js"), "new dependency\n"),
    writeFile(path.join(root, ".cache", "new-result"), "new cache\n"),
  ]);
  await repository.restore(state.id);

  assert.equal(await readFile(path.join(root, "src", "index.ts"), "utf8"), "original\n");
  assert.equal(await readFile(path.join(root, "node_modules", "package", "index.js"), "utf8"), "new dependency\n");
  assert.equal(await readFile(path.join(root, ".cache", "new-result"), "utf8"), "new cache\n");
});

test("workspace policy changes are rejected instead of migrated", async (t) => {
  const values = await fixture("thread-workspace-policy-version-");
  t.after(values.cleanup);

  const repository = new WorkspaceStateRepository(values.project);
  await repository.initialize();
  const oldPolicy = JSON.parse(await readFile(repository.policyPath, "utf8")) as Record<string, unknown>;
  delete oldPolicy.excludedDirectoryNames;
  await writeFile(repository.policyPath, `${JSON.stringify(oldPolicy, null, 2)}\n`);

  await assert.rejects(
    new WorkspaceStateRepository(values.project).initialize(),
    /old workspace states are not migrated or loaded/,
  );
});
