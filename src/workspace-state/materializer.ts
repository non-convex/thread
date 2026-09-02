import { chmod, lstat, mkdir, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceEntry, WorkspaceState } from "./model.js";
import type { WorkspaceStateStore } from "./store.js";

function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

export class WorkspaceMaterializer {
  constructor(private readonly store: WorkspaceStateStore) {}

  async materialize(stateId: string, targetRoot: string): Promise<void> {
    await this.store.verify(stateId);
    await mkdir(targetRoot, { recursive: true });
    await this.restoreState(await this.store.read(stateId), targetRoot);
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
      if (this.store.exclusions.matches(relative, child.isDirectory() || child.isSymbolicLink())) continue;
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
}
