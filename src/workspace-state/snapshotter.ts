import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../utils/id.js";
import { WORKSPACE_STATE_FORMAT, type StagedWorkspaceState, type WorkspaceEntry, type WorkspaceState } from "./model.js";
import type { WorkspaceStateStore } from "./store.js";

function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

export class WorkspaceSnapshotter {
  constructor(private readonly store: WorkspaceStateStore) {}

  async capture(rootPath: string): Promise<WorkspaceState> {
    const staged = await this.captureStaged(rootPath);
    return staged.persisted;
  }

  async captureStaged(rootPath: string): Promise<StagedWorkspaceState> {
    await this.store.initialize();
    const entries: WorkspaceEntry[] = [];
    let blobWrites: Promise<void> = Promise.resolve();
    const scheduleBlob = (blobId: string, content: Buffer) => {
      blobWrites = blobWrites.then(() => this.store.storeBlob(blobId, content));
      void blobWrites.catch(() => undefined);
    };
    try {
      await this.walk(rootPath, rootPath, entries, scheduleBlob);
    } catch (cause) {
      await blobWrites.catch(() => undefined);
      throw cause;
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const state: WorkspaceState = {
      format: WORKSPACE_STATE_FORMAT,
      formatVersion: 1,
      id: this.store.stateId(entries),
      projectId: this.store.project.id,
      capturedAt: Date.now(),
      policy: structuredClone(this.store.policy),
      entries,
    };
    const persisted = blobWrites.then(() => this.store.persist(state));
    void persisted.catch(() => undefined);
    return { state, persisted };
  }

  private async walk(
    rootPath: string,
    directory: string,
    output: WorkspaceEntry[],
    scheduleBlob: (blobId: string, content: Buffer) => void,
  ): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = slash(path.relative(rootPath, absolute));
      if (this.excluded(relative)) continue;
      const info = await lstat(absolute);
      const mode = info.mode & 0o777;
      if (child.isSymbolicLink()) {
        output.push({ path: relative, kind: "symlink", mode, target: await readlink(absolute) });
      } else if (child.isDirectory()) {
        output.push({ path: relative, kind: "directory", mode });
        await this.walk(rootPath, absolute, output, scheduleBlob);
      } else if (child.isFile()) {
        const content = await readFile(absolute);
        const blobId = sha256(content);
        scheduleBlob(blobId, content);
        output.push({ path: relative, kind: "file", mode, size: content.length, blobId });
      }
    }
  }

  private excluded(relativePath: string): boolean {
    return this.store.policy.excludedPaths.some((prefix) =>
      relativePath === prefix || relativePath.startsWith(`${prefix}/`)
    );
  }
}
