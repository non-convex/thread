import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Project } from "../project/model.js";
import { sha256 } from "../utils/id.js";
import { WORKSPACE_STATE_FORMAT, type WorkspaceEntry, type WorkspaceState, type WorkspaceStatePolicy } from "./model.js";

function assertStateId(stateId: string): void {
  if (!/^state_[0-9a-f]{64}$/.test(stateId)) throw new Error(`Invalid workspace state id: ${stateId}`);
}

function assertBlobId(blobId: string): void {
  if (!/^[0-9a-f]{64}$/.test(blobId)) throw new Error(`Invalid workspace blob id: ${blobId}`);
}

function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export class WorkspaceStateStore {
  readonly statesPath: string;
  readonly blobsPath: string;
  readonly policyPath: string;
  private initialized = false;

  constructor(readonly project: Project, readonly policy: WorkspaceStatePolicy) {
    this.statesPath = path.join(project.statePath, "workspace-states", "states");
    this.blobsPath = path.join(project.statePath, "workspace-states", "blobs");
    this.policyPath = path.join(project.statePath, "workspace-states", "policy.json");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.statesPath, { recursive: true });
    await mkdir(this.blobsPath, { recursive: true });
    let existing: unknown;
    try {
      existing = JSON.parse(await readFile(this.policyPath, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing === undefined) {
      await this.atomicWrite(this.policyPath, Buffer.from(`${JSON.stringify(this.policy, null, 2)}\n`, "utf8"));
    } else if (JSON.stringify(existing) !== JSON.stringify(this.policy)) {
      throw new Error(`Workspace capture policy differs from the stored policy at ${this.policyPath}`);
    }
    this.initialized = true;
  }

  stateId(entries: readonly WorkspaceEntry[]): string {
    return `state_${sha256(JSON.stringify({ projectId: this.project.id, policy: this.policy, entries }))}`;
  }

  async storeBlob(blobId: string, content: Buffer): Promise<void> {
    assertBlobId(blobId);
    const target = this.blobPath(blobId);
    if (await exists(target)) return;
    await this.atomicWrite(target, content);
  }

  readBlob(blobId: string): Promise<Buffer> {
    assertBlobId(blobId);
    return readFile(this.blobPath(blobId));
  }

  async persist(state: WorkspaceState): Promise<WorkspaceState> {
    await this.initialize();
    const target = this.statePath(state.id);
    if (!(await exists(target))) {
      await this.atomicWrite(target, Buffer.from(`${JSON.stringify(state)}\n`, "utf8"));
    }
    await this.verify(state.id);
    return this.read(state.id);
  }

  async read(stateId: string): Promise<WorkspaceState> {
    assertStateId(stateId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.statePath(stateId), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Workspace state is missing: ${stateId}`);
      throw error;
    }
    if (typeof parsed !== "object" || parsed === null) throw new Error(`Workspace state is invalid: ${stateId}`);
    const state = parsed as Partial<WorkspaceState>;
    if (state.format !== WORKSPACE_STATE_FORMAT || state.formatVersion !== 1 || state.id !== stateId ||
        state.projectId !== this.project.id || !Array.isArray(state.entries)) {
      throw new Error(`Workspace state is corrupt or belongs to another project: ${stateId}`);
    }
    return state as WorkspaceState;
  }

  async verify(stateId: string): Promise<void> {
    const state = await this.read(stateId);
    if (JSON.stringify(state.policy) !== JSON.stringify(this.policy)) {
      throw new Error(`Workspace state ${stateId} uses a different capture policy`);
    }
    if (this.stateId(state.entries) !== state.id) throw new Error(`Workspace state manifest digest is invalid: ${stateId}`);
    const paths = new Set<string>();
    for (const entry of state.entries) {
      if (typeof entry !== "object" || entry === null || typeof entry.path !== "string" ||
          !entry.path || path.isAbsolute(entry.path) || entry.path.split("/").includes("..")) {
        throw new Error(`Workspace state ${stateId} contains an unsafe path`);
      }
      if (this.policy.excludedPaths.some((prefix) => entry.path === prefix || entry.path.startsWith(`${prefix}/`))) {
        throw new Error(`Workspace state ${stateId} contains excluded path ${entry.path}`);
      }
      if (paths.has(entry.path)) throw new Error(`Workspace state ${stateId} contains duplicate path ${entry.path}`);
      paths.add(entry.path);
      if (!Number.isInteger(entry.mode) || entry.mode < 0) throw new Error(`Workspace state ${stateId} has invalid mode for ${entry.path}`);
      const runtimeKind: unknown = (entry as { kind?: unknown }).kind;
      if (runtimeKind !== "directory" && runtimeKind !== "symlink" && runtimeKind !== "file") {
        throw new Error(`Workspace state ${stateId} has an unknown entry kind at ${entry.path}`);
      }
      if (entry.kind === "symlink" && typeof entry.target !== "string") {
        throw new Error(`Workspace state ${stateId} has an invalid symlink at ${entry.path}`);
      }
      if (entry.kind !== "file") continue;
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[0-9a-f]{64}$/.test(entry.blobId)) {
        throw new Error(`Workspace state ${stateId} has invalid file metadata for ${entry.path}`);
      }
      const content = await this.readBlob(entry.blobId).catch((error) => {
        throw new Error(`Workspace state ${stateId} is missing blob ${entry.blobId}`, { cause: error });
      });
      if (content.length !== entry.size || sha256(content) !== entry.blobId) {
        throw new Error(`Workspace state ${stateId} has a corrupt blob ${entry.blobId}`);
      }
    }
    for (const entry of state.entries) {
      let parent = slash(path.dirname(entry.path));
      while (parent !== ".") {
        const parentEntry = state.entries.find((candidate) => candidate.path === parent);
        if (parentEntry && parentEntry.kind !== "directory") {
          throw new Error(`Workspace state ${stateId} places ${entry.path} below non-directory ${parent}`);
        }
        parent = slash(path.dirname(parent));
      }
    }
  }

  async garbageCollect(referencedStateIds: ReadonlySet<string>): Promise<{ statesRemoved: number; blobsRemoved: number }> {
    await this.initialize();
    let statesRemoved = 0;
    for (const name of await readdir(this.statesPath)) {
      const match = /^(state_[0-9a-f]{64})\.json$/.exec(name);
      if (!match || referencedStateIds.has(match[1]!)) continue;
      await rm(path.join(this.statesPath, name), { force: true });
      statesRemoved++;
    }
    const retainedBlobs = new Set<string>();
    for (const name of await readdir(this.statesPath)) {
      const match = /^(state_[0-9a-f]{64})\.json$/.exec(name);
      if (!match) continue;
      const state = await this.read(match[1]!);
      for (const entry of state.entries) if (entry.kind === "file") retainedBlobs.add(entry.blobId);
    }
    let blobsRemoved = 0;
    for (const prefix of await readdir(this.blobsPath, { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name)) continue;
      const prefixPath = path.join(this.blobsPath, prefix.name);
      for (const blob of await readdir(prefixPath, { withFileTypes: true })) {
        const blobId = `${prefix.name}${blob.name}`;
        if (!blob.isFile() || retainedBlobs.has(blobId)) continue;
        await rm(path.join(prefixPath, blob.name), { force: true });
        blobsRemoved++;
      }
      if ((await readdir(prefixPath)).length === 0) await rm(prefixPath, { recursive: true, force: true });
    }
    return { statesRemoved, blobsRemoved };
  }

  private blobPath(blobId: string): string {
    return path.join(this.blobsPath, blobId.slice(0, 2), blobId.slice(2));
  }

  private statePath(stateId: string): string {
    return path.join(this.statesPath, `${stateId}.json`);
  }

  private async atomicWrite(target: string, content: Buffer): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await writeFile(temporary, content);
      try {
        await rename(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        if (!(await exists(target))) throw error;
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
