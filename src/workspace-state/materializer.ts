import { chmod, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256 } from "../utils/id.js";
import type { WorkspaceEntry, WorkspaceOperation, WorkspaceState } from "./model.js";
import type { WorkspaceStateStore } from "./store.js";

function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

type WorkspaceWriteOperation = Exclude<WorkspaceOperation, { kind: "delete" }>;

export class WorkspaceMaterializer {
  constructor(private readonly store: WorkspaceStateStore) {}

  async materialize(stateId: string, targetRoot: string): Promise<void> {
    await this.store.verify(stateId);
    const state = await this.store.read(stateId);
    await mkdir(targetRoot, { recursive: true });
    await this.restoreState(state, targetRoot);
  }

  async restoreState(state: WorkspaceState, targetRoot: string): Promise<void> {
    const targetByPath = new Map(state.entries.map((entry) => [entry.path, entry]));
    const current: WorkspaceEntry[] = [];
    await this.walk(targetRoot, targetRoot, current);
    const removals = current
      .filter((entry) => !targetByPath.has(entry.path) || targetByPath.get(entry.path)!.kind !== entry.kind)
      .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
    for (const entry of removals) await rm(this.absolute(targetRoot, entry.path), { recursive: true, force: true });

    const directories = state.entries.filter((entry) => entry.kind === "directory")
      .sort((left, right) => left.path.split("/").length - right.path.split("/").length);
    for (const entry of directories) {
      const target = this.absolute(targetRoot, entry.path);
      await mkdir(target, { recursive: true });
      await chmod(target, entry.mode).catch(() => undefined);
    }
    for (const entry of state.entries) {
      if (entry.kind === "directory") continue;
      const target = this.absolute(targetRoot, entry.path);
      await mkdir(path.dirname(target), { recursive: true });
      await rm(target, { recursive: true, force: true });
      if (entry.kind === "symlink") await symlink(entry.target, target, "file");
      else await writeFile(target, await this.store.readBlob(entry.blobId));
      await chmod(target, entry.mode).catch(() => undefined);
    }
  }

  async applyOperations(
    operations: readonly WorkspaceOperation[],
    targetRoot: string,
    expected: ReadonlyMap<string, WorkspaceEntry>,
  ): Promise<void> {
    const removals = operations
      .filter((operation) => operation.kind === "delete" || (operation.kind === "modify" && operation.before.kind !== operation.after.kind))
      .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
    const writes = operations.filter((operation): operation is WorkspaceWriteOperation => operation.kind !== "delete");
    const directories = writes
      .filter((operation) => operation.after.kind === "directory")
      .sort((left, right) => left.path.split("/").length - right.path.split("/").length);
    const leaves = writes.filter((operation) => operation.after.kind !== "directory");

    for (const operation of removals) {
      await this.assertExpected(targetRoot, operation.path, expected.get(operation.path));
      await rm(this.absolute(targetRoot, operation.path), { recursive: true, force: true });
    }
    for (const operation of directories) {
      if (!(operation.kind === "modify" && operation.before.kind !== operation.after.kind)) {
        await this.assertExpected(targetRoot, operation.path, expected.get(operation.path));
      }
      const target = this.absolute(targetRoot, operation.path);
      await mkdir(target, { recursive: true });
      await chmod(target, operation.after.mode).catch(() => undefined);
    }
    for (const operation of leaves) {
      if (!(operation.kind === "modify" && operation.before.kind !== operation.after.kind)) {
        await this.assertExpected(targetRoot, operation.path, expected.get(operation.path));
      }
      const target = this.absolute(targetRoot, operation.path);
      await mkdir(path.dirname(target), { recursive: true });
      await rm(target, { recursive: true, force: true });
      if (operation.after.kind === "symlink") await symlink(operation.after.target, target, "file");
      else if (operation.after.kind === "file") await writeFile(target, await this.store.readBlob(operation.after.blobId));
      else throw new Error(`Unexpected directory leaf operation: ${operation.path}`);
      await chmod(target, operation.after.mode).catch(() => undefined);
    }
  }

  private async walk(root: string, directory: string, output: WorkspaceEntry[]): Promise<void> {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = slash(path.relative(root, absolute));
      if (this.store.policy.excludedPaths.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) continue;
      const info = await lstat(absolute);
      const mode = info.mode & 0o777;
      if (child.isSymbolicLink()) output.push({ path: relative, kind: "symlink", mode, target: await readlink(absolute) });
      else if (child.isDirectory()) {
        output.push({ path: relative, kind: "directory", mode });
        await this.walk(root, absolute, output);
      } else if (child.isFile()) {
        output.push({ path: relative, kind: "file", mode, size: Number(info.size), blobId: "0".repeat(64) });
      }
    }
  }

  private absolute(root: string, relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
      throw new Error(`Unsafe workspace path: ${relativePath}`);
    }
    const target = path.resolve(root, relativePath);
    const prefix = `${path.resolve(root)}${path.sep}`;
    if (!target.startsWith(prefix)) throw new Error(`Workspace path escapes target root: ${relativePath}`);
    return target;
  }

  private async assertExpected(root: string, relativePath: string, expected: WorkspaceEntry | undefined): Promise<void> {
    const actual = await this.entryAt(root, relativePath);
    if (!isDeepStrictEqual(actual, expected)) throw new WorkspaceApplyRaceError(relativePath);
  }

  private async entryAt(root: string, relativePath: string): Promise<WorkspaceEntry | undefined> {
    const target = this.absolute(root, relativePath);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const mode = info.mode & 0o777;
    if (info.isSymbolicLink()) return { path: relativePath, kind: "symlink", mode, target: await readlink(target) };
    if (info.isDirectory()) return { path: relativePath, kind: "directory", mode };
    if (info.isFile()) {
      const content = await readFile(target);
      return { path: relativePath, kind: "file", mode, size: content.length, blobId: sha256(content) };
    }
    return undefined;
  }
}

export class WorkspaceApplyRaceError extends Error {
  constructor(readonly path: string) {
    super(`Workspace path changed during ChangeSet application: ${path}`);
    this.name = "WorkspaceApplyRaceError";
  }
}
