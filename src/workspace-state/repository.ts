import { access, mkdir, readFile, readdir, readlink, rename, rm, lstat, symlink, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import type { Project } from "../project/model.js";
import { sha256 } from "../utils/id.js";
import {
  WORKSPACE_STATE_FORMAT,
  type StagedWorkspaceState,
  type WorkspaceEntry,
  type WorkspaceState,
  type WorkspaceStatePolicy,
} from "./model.js";

function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

function assertRelative(relativePath: string): void {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
    throw new Error(`Unsafe workspace-state path: ${relativePath}`);
  }
}

function normalizeExcludedPath(value: string): string {
  const normalized = slash(value).replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || path.isAbsolute(value) || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Workspace exclusion must be a project-relative path: ${value}`);
  }
  return normalized;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export interface WorkspaceStateRepositoryOptions {
  excludedPaths?: readonly string[];
}

export class WorkspaceStateRepository {
  readonly rootPath: string;
  readonly statesPath: string;
  readonly blobsPath: string;
  readonly policyPath: string;
  readonly policy: WorkspaceStatePolicy;
  private initialized = false;

  constructor(readonly project: Project, options: WorkspaceStateRepositoryOptions = {}) {
    this.rootPath = project.rootPath;
    this.statesPath = path.join(project.statePath, "workspace-states", "states");
    this.blobsPath = path.join(project.statePath, "workspace-states", "blobs");
    this.policyPath = path.join(project.statePath, "workspace-states", "policy.json");
    const excluded = new Set([".git", ".thread", ...(options.excludedPaths ?? []).map(normalizeExcludedPath)]);
    const relativeStatePath = slash(path.relative(project.rootPath, project.statePath));
    if (relativeStatePath && !relativeStatePath.startsWith("../") && relativeStatePath !== "..") excluded.add(relativeStatePath);
    this.policy = {
      excludedPaths: [...excluded].sort(),
      includeIgnoredFiles: true,
      includeProjectMetadata: false,
    };
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
      throw new Error(
        `Workspace capture policy for ${this.project.rootPath} differs from the policy already stored at ${this.policyPath}`,
      );
    }
    this.initialized = true;
  }

  async capture(): Promise<WorkspaceState> {
    const staged = await this.captureStaged();
    return staged.persisted;
  }

  async captureStaged(): Promise<StagedWorkspaceState> {
    await this.initialize();
    const entries: WorkspaceEntry[] = [];
    let blobWrites: Promise<void> = Promise.resolve();
    const scheduleBlobWrite = (blobId: string, content: Buffer): void => {
      blobWrites = blobWrites.then(() => this.storeBlob(blobId, content));
      // The staged capture returns before this queue drains. Keep failures
      // observed until the caller reaches its durability barrier.
      void blobWrites.catch(() => undefined);
    };
    try {
      await this.walk(this.rootPath, "", entries, scheduleBlobWrite);
    } catch (cause) {
      await blobWrites.catch(() => undefined);
      throw cause;
    }
    entries.sort((left, right) => left.path.localeCompare(right.path));
    const identity = JSON.stringify({ projectId: this.project.id, policy: this.policy, entries });
    const id = `state_${sha256(identity)}`;
    const state: WorkspaceState = {
      format: WORKSPACE_STATE_FORMAT,
      formatVersion: 1,
      id,
      projectId: this.project.id,
      capturedAt: Date.now(),
      policy: structuredClone(this.policy),
      entries,
    };
    const target = this.statePath(id);
    const persisted = blobWrites.then(async () => {
      const alreadyStored = await exists(target);
      if (!alreadyStored) await this.atomicWrite(target, Buffer.from(`${JSON.stringify(state)}\n`, "utf8"));
      await this.verify(id);
      return alreadyStored ? this.read(id) : state;
    });
    void persisted.catch(() => undefined);
    return { state, persisted };
  }

  private async walk(
    absoluteDirectory: string,
    relativeDirectory: string,
    output: WorkspaceEntry[],
    scheduleBlobWrite: (blobId: string, content: Buffer) => void,
  ): Promise<void> {
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = slash(path.join(relativeDirectory, child.name));
      if (this.excluded(relativePath)) continue;
      const absolutePath = path.join(absoluteDirectory, child.name);
      const info = await lstat(absolutePath, { bigint: false });
      const mode = info.mode & 0o777;
      if (child.isSymbolicLink()) {
        output.push({ path: relativePath, kind: "symlink", mode, target: await readlink(absolutePath) });
        continue;
      }
      if (child.isDirectory()) {
        output.push({ path: relativePath, kind: "directory", mode });
        await this.walk(absolutePath, relativePath, output, scheduleBlobWrite);
        continue;
      }
      if (!child.isFile()) continue;
      const content = await readFile(absolutePath);
      const blobId = sha256(content);
      scheduleBlobWrite(blobId, content);
      output.push({ path: relativePath, kind: "file", mode, size: content.length, blobId });
    }
  }

  private excluded(relativePath: string): boolean {
    return this.policy.excludedPaths.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
  }

  private blobPath(blobId: string): string {
    if (!/^[0-9a-f]{64}$/.test(blobId)) throw new Error(`Invalid workspace blob id: ${blobId}`);
    return path.join(this.blobsPath, blobId.slice(0, 2), blobId.slice(2));
  }

  private statePath(stateId: string): string {
    if (!/^state_[0-9a-f]{64}$/.test(stateId)) throw new Error(`Invalid workspace state id: ${stateId}`);
    return path.join(this.statesPath, `${stateId}.json`);
  }

  private async storeBlob(blobId: string, content: Buffer): Promise<void> {
    const target = this.blobPath(blobId);
    if (await exists(target)) return;
    await this.atomicWrite(target, content);
  }

  private async atomicWrite(target: string, content: Buffer): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await writeFile(temporary, content);
      try {
        await rename(temporary, target);
      } catch (error) {
        if (!(["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) || !(await exists(target))) {
          throw error;
        }
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async read(stateId: string): Promise<WorkspaceState> {
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
    const identity = JSON.stringify({ projectId: state.projectId, policy: state.policy, entries: state.entries });
    if (`state_${sha256(identity)}` !== state.id) throw new Error(`Workspace state manifest digest is invalid: ${stateId}`);
    const paths = new Set<string>();
    for (const entry of state.entries) {
      if (typeof entry !== "object" || entry === null || typeof entry.path !== "string") {
        throw new Error(`Workspace state ${stateId} contains an invalid entry`);
      }
      assertRelative(entry.path);
      if (this.excluded(entry.path)) throw new Error(`Workspace state ${stateId} contains excluded path ${entry.path}`);
      if (paths.has(entry.path)) throw new Error(`Workspace state ${stateId} contains duplicate path ${entry.path}`);
      paths.add(entry.path);
      if (!Number.isInteger(entry.mode) || entry.mode < 0) throw new Error(`Workspace state ${stateId} has invalid mode for ${entry.path}`);
      if (entry.kind === "symlink" && typeof entry.target !== "string") {
        throw new Error(`Workspace state ${stateId} has an invalid symlink at ${entry.path}`);
      }
      const runtimeKind: unknown = (entry as { kind?: unknown }).kind;
      if (runtimeKind !== "directory" && runtimeKind !== "symlink" && runtimeKind !== "file") {
        throw new Error(`Workspace state ${stateId} has an unknown entry kind at ${entry.path}`);
      }
      if (entry.kind !== "file") continue;
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[0-9a-f]{64}$/.test(entry.blobId)) {
        throw new Error(`Workspace state ${stateId} has invalid file metadata for ${entry.path}`);
      }
      let content: Buffer;
      try {
        content = await readFile(this.blobPath(entry.blobId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Workspace state ${stateId} is missing blob ${entry.blobId}`);
        }
        throw error;
      }
      if (content.length !== entry.size || sha256(content) !== entry.blobId) {
        throw new Error(`Workspace state ${stateId} has a corrupt blob for ${entry.path}`);
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

  async restore(stateId: string): Promise<void> {
    await this.verify(stateId);
    const state = await this.read(stateId);
    const targetByPath = new Map(state.entries.map((entry) => [entry.path, entry]));
    const current: WorkspaceEntry[] = [];
    await this.walkWithoutBlobs(this.rootPath, "", current);
    const removals = current
      .filter((entry) => !targetByPath.has(entry.path) || targetByPath.get(entry.path)!.kind !== entry.kind)
      .sort((left, right) => right.path.split("/").length - left.path.split("/").length);
    for (const entry of removals) await rm(this.absolute(entry.path), { recursive: true, force: true });

    const directories = state.entries.filter((entry) => entry.kind === "directory")
      .sort((left, right) => left.path.split("/").length - right.path.split("/").length);
    for (const entry of directories) {
      await mkdir(this.absolute(entry.path), { recursive: true });
      await chmod(this.absolute(entry.path), entry.mode).catch(() => undefined);
    }
    for (const entry of state.entries) {
      if (entry.kind === "directory") continue;
      const target = this.absolute(entry.path);
      await mkdir(path.dirname(target), { recursive: true });
      await rm(target, { recursive: true, force: true });
      if (entry.kind === "symlink") {
        await symlink(entry.target, target, "file");
      } else {
        await writeFile(target, await readFile(this.blobPath(entry.blobId)));
        await chmod(target, entry.mode).catch(() => undefined);
      }
    }
  }

  private async walkWithoutBlobs(absoluteDirectory: string, relativeDirectory: string, output: WorkspaceEntry[]): Promise<void> {
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const child of children) {
      const relativePath = slash(path.join(relativeDirectory, child.name));
      if (this.excluded(relativePath)) continue;
      const absolutePath = path.join(absoluteDirectory, child.name);
      const info = await lstat(absolutePath, { bigint: false });
      const mode = info.mode & 0o777;
      if (child.isSymbolicLink()) {
        output.push({ path: relativePath, kind: "symlink", mode, target: await readlink(absolutePath) });
      } else if (child.isDirectory()) {
        output.push({ path: relativePath, kind: "directory", mode });
        await this.walkWithoutBlobs(absolutePath, relativePath, output);
      } else if (child.isFile()) {
        output.push({ path: relativePath, kind: "file", mode, size: Number(info.size), blobId: "0".repeat(64) });
      }
    }
  }

  private absolute(relativePath: string): string {
    assertRelative(relativePath);
    const target = path.resolve(this.rootPath, relativePath);
    const prefix = `${path.resolve(this.rootPath)}${path.sep}`;
    if (!target.startsWith(prefix)) throw new Error(`Workspace state path escapes project: ${relativePath}`);
    return target;
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
        if (!blob.isFile() || !/^[0-9a-f]{64}$/.test(blobId) || retainedBlobs.has(blobId)) continue;
        await rm(path.join(prefixPath, blob.name), { force: true });
        blobsRemoved++;
      }
      if ((await readdir(prefixPath)).length === 0) await rm(prefixPath, { recursive: true, force: true });
    }
    return { statesRemoved, blobsRemoved };
  }

  async deleteUnreferenced(referencedStateIds: ReadonlySet<string>): Promise<number> {
    return (await this.garbageCollect(referencedStateIds)).statesRemoved;
  }
}
