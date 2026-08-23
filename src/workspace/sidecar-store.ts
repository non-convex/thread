import { chmod, copyFile, lstat, mkdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { splitNull } from "../utils/process.js";
import { normalizeGitPath, runGit } from "./git.js";
import type { GitWorkspace } from "./discovery.js";

export interface WorkspaceSnapshot {
  treeOid: string;
  retentionCommitOid: string;
  pathCount: number;
  elapsedMs: number;
}

export interface SidecarStoreOptions {
  workspace: GitWorkspace;
  sessionId: string;
}

interface IndexEntry {
  mode: string;
  oid: string;
  stage: number;
  path: string;
}

export interface WorkspaceMergeResult {
  clean: boolean;
  treeOid?: string;
  conflicts: string[];
}

export interface WorkspaceFileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  oldOid?: string;
  newOid?: string;
  additions?: number;
  deletions?: number;
  binary: boolean;
}

export interface WorkspaceRestorePlan {
  writes: string[];
  deletes: string[];
  collisions: string[];
  skippedGitlinks: string[];
}

function parseIndexEntries(buffer: Buffer): IndexEntry[] {
  return splitNull(buffer).map((line) => {
    const match = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error(`Unexpected git ls-files --stage output: ${line}`);
    return { mode: match[1]!, oid: match[2]!, stage: Number(match[3]), path: match[4]! };
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export class SidecarWorkspaceStore {
  readonly workspace: GitWorkspace;
  readonly sessionId: string;
  readonly storeGitDir: string;
  readonly indexPath: string;
  readonly keepRef: string;
  private initialized = false;

  constructor(options: SidecarStoreOptions) {
    this.workspace = options.workspace;
    this.sessionId = options.sessionId;
    this.storeGitDir = path.join(options.workspace.sidecarRoot, "store.git");
    this.indexPath = path.join(options.workspace.sidecarRoot, "indexes", options.sessionId);
    this.keepRef = `refs/keep/${options.sessionId}`;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(path.dirname(this.indexPath), { recursive: true });
    await mkdir(path.join(this.workspace.sidecarRoot, "tmp"), { recursive: true });
    if (!(await exists(this.storeGitDir))) {
      await runGit(["init", "--bare", this.storeGitDir]);
    }
    await this.copyRelevantConfig("core.autocrlf");
    await this.copyRelevantConfig("core.symlinks");
    await this.copyRelevantConfig("core.filemode");
    this.initialized = true;
  }

  private async copyRelevantConfig(key: string): Promise<void> {
    const value = await runGit(["-C", this.workspace.rootPath, "config", "--get", key], {
      allowExitCodes: [0, 1],
    });
    if (value.code === 0) {
      await this.sidecarGit(["config", key, value.stdout.toString("utf8").trim()]);
    }
  }

  private sidecarGit(args: readonly string[], options: Parameters<typeof runGit>[1] = {}) {
    return runGit([`--git-dir=${this.storeGitDir}`, ...args], options);
  }

  private indexEnv(indexPath = this.indexPath): NodeJS.ProcessEnv {
    return { ...process.env, GIT_INDEX_FILE: indexPath };
  }

  private async mainIndexEntries(): Promise<IndexEntry[]> {
    const result = await runGit(["-C", this.workspace.rootPath, "ls-files", "--stage", "-z"]);
    return parseIndexEntries(result.stdout);
  }

  private async candidatePaths(): Promise<{
    regular: string[];
    gitlinks: IndexEntry[];
    symlinks: Array<{ path: string; content: Buffer }>;
    trackedModes: Map<string, string>;
  }> {
    const [indexEntries, othersResult] = await Promise.all([
      this.mainIndexEntries(),
      runGit(["-C", this.workspace.rootPath, "ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    const regular = new Set<string>();
    const gitlinks: IndexEntry[] = [];
    const symlinks: Array<{ path: string; content: Buffer }> = [];
    const trackedModes = new Map<string, string>();
    for (const entry of indexEntries) {
      if (entry.stage !== 0) continue;
      if (entry.mode === "160000") {
        gitlinks.push(entry);
      } else if (entry.mode === "120000" && (await exists(path.join(this.workspace.rootPath, entry.path)))) {
        const absolute = path.join(this.workspace.rootPath, entry.path);
        const stat = await lstat(absolute);
        const content = stat.isSymbolicLink()
          ? Buffer.from(await readlink(absolute), "utf8")
          : await readFile(absolute);
        symlinks.push({ path: entry.path, content });
      } else if (await exists(path.join(this.workspace.rootPath, entry.path))) {
        regular.add(entry.path);
        trackedModes.set(entry.path, entry.mode);
      }
    }
    for (const candidate of splitNull(othersResult.stdout)) {
      const absolute = path.join(this.workspace.rootPath, candidate);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        symlinks.push({ path: candidate, content: Buffer.from(await readlink(absolute), "utf8") });
      } else {
        regular.add(candidate);
      }
    }
    for (const gitlink of gitlinks) regular.delete(gitlink.path);
    for (const link of symlinks) regular.delete(link.path);
    return { regular: [...regular].sort(), gitlinks, symlinks, trackedModes };
  }

  async capture(parentRetentionCommitOid?: string): Promise<WorkspaceSnapshot> {
    const started = performance.now();
    await this.initialize();
    const { regular, gitlinks, symlinks, trackedModes } = await this.candidatePaths();
    const env = this.indexEnv();
    await rm(this.indexPath, { force: true });
    await this.sidecarGit(["read-tree", "--empty"], { env });
    if (regular.length > 0) {
      const input = Buffer.from(`${regular.join("\0")}\0`, "utf8");
      await this.sidecarGit(
        [
          `--work-tree=${this.workspace.rootPath}`,
          "add",
          "-f",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        { env, input },
      );
    }
    if (process.platform === "win32" && trackedModes.size > 0) {
      const indexed = parseIndexEntries((await this.sidecarGit(["ls-files", "--stage", "-z"], { env })).stdout);
      const byPath = new Map(indexed.map((entry) => [entry.path, entry]));
      for (const [filePath, mode] of trackedModes) {
        const entry = byPath.get(filePath);
        if (entry && entry.mode !== mode) {
          await this.sidecarGit(["update-index", "--add", "--cacheinfo", `${mode},${entry.oid},${filePath}`], { env });
        }
      }
    }
    for (const link of symlinks) {
      const object = await this.sidecarGit(["hash-object", "-w", "--stdin"], { input: link.content });
      const oid = object.stdout.toString("utf8").trim();
      await this.sidecarGit(["update-index", "--add", "--cacheinfo", `120000,${oid},${link.path}`], { env });
    }
    for (const entry of gitlinks) {
      await this.sidecarGit(
        ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.oid},${entry.path}`],
        { env },
      );
    }
    const tree = await this.sidecarGit(["write-tree"], { env });
    const treeOid = tree.stdout.toString("utf8").trim();
    const retentionCommitOid = await this.createRetentionCommit(treeOid, parentRetentionCommitOid);
    await this.verifySnapshot(treeOid, retentionCommitOid);
    return {
      treeOid,
      retentionCommitOid,
      pathCount: regular.length + gitlinks.length + symlinks.length,
      elapsedMs: performance.now() - started,
    };
  }

  async retainTree(treeOid: string, parentRetentionCommitOid?: string): Promise<WorkspaceSnapshot> {
    const started = performance.now();
    await this.initialize();
    await this.sidecarGit(["cat-file", "-e", `${treeOid}^{tree}`]);
    const retentionCommitOid = await this.createRetentionCommit(treeOid, parentRetentionCommitOid);
    await this.verifySnapshot(treeOid, retentionCommitOid);
    return {
      treeOid,
      retentionCommitOid,
      pathCount: (await this.listTree(treeOid)).length,
      elapsedMs: performance.now() - started,
    };
  }

  private async createRetentionCommit(treeOid: string, parentRetentionCommitOid?: string): Promise<string> {
    const commitArgs = ["commit-tree", treeOid];
    if (parentRetentionCommitOid) commitArgs.push("-p", parentRetentionCommitOid);
    const retention = await this.sidecarGit(commitArgs, {
      input: `thread snapshot ${new Date().toISOString()}\n`,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "thread",
        GIT_AUTHOR_EMAIL: "thread@local",
        GIT_COMMITTER_NAME: "thread",
        GIT_COMMITTER_EMAIL: "thread@local",
      },
    });
    return retention.stdout.toString("utf8").trim();
  }

  async verifySnapshot(treeOid: string, retentionCommitOid: string): Promise<void> {
    const alternates = path.join(this.storeGitDir, "objects", "info", "alternates");
    if (await exists(alternates)) {
      const content = (await readFile(alternates, "utf8")).trim();
      if (content) throw new Error(`Sidecar object store unexpectedly uses alternates: ${content}`);
    }
    await this.sidecarGit(["cat-file", "-e", `${treeOid}^{tree}`]);
    await this.sidecarGit(["cat-file", "-e", `${retentionCommitOid}^{commit}`]);
    const commitTree = await this.sidecarGit(["show", "-s", "--format=%T", retentionCommitOid]);
    if (commitTree.stdout.toString("utf8").trim() !== treeOid) {
      throw new Error(`Retention commit ${retentionCommitOid} does not protect tree ${treeOid}`);
    }
  }

  async verifyObjectSet(snapshots: readonly { treeOid: string; retentionCommitOid: string }[]): Promise<void> {
    const expected = new Map<string, "tree" | "commit">();
    for (const snapshot of snapshots) {
      expected.set(snapshot.treeOid, "tree");
      expected.set(snapshot.retentionCommitOid, "commit");
    }
    if (expected.size === 0) return;
    const result = await this.sidecarGit(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
      input: `${[...expected.keys()].join("\n")}\n`,
    });
    const seen = new Set<string>();
    for (const line of result.stdout.toString("utf8").trim().split(/\r?\n/)) {
      const [oid, type] = line.split(" ");
      if (!oid || !type || type === "missing") throw new Error(`Sidecar object is missing: ${oid ?? line}`);
      const wanted = expected.get(oid);
      if (wanted !== type) throw new Error(`Sidecar object ${oid} is ${type}; expected ${wanted}`);
      seen.add(oid);
    }
    for (const oid of expected.keys()) {
      if (!seen.has(oid)) throw new Error(`Sidecar object was not checked: ${oid}`);
    }
  }

  async updateKeepRef(retentionCommitOid: string, expectedOld?: string): Promise<void> {
    const args = ["update-ref", this.keepRef, retentionCommitOid];
    if (expectedOld !== undefined) args.push(expectedOld);
    await this.sidecarGit(args);
  }

  async readKeepRef(): Promise<string | undefined> {
    const result = await this.sidecarGit(["rev-parse", "--verify", this.keepRef], { allowExitCodes: [0, 128] });
    return result.code === 0 ? result.stdout.toString("utf8").trim() : undefined;
  }

  async listTree(treeOid: string): Promise<IndexEntry[]> {
    const result = await this.sidecarGit(["ls-tree", "-r", "-z", treeOid]);
    return splitNull(result.stdout).map((line) => {
      const match = /^(\d+) ([a-z]+) ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
      if (!match) throw new Error(`Unexpected git ls-tree output: ${line}`);
      return { mode: match[1]!, oid: match[3]!, stage: 0, path: match[4]! };
    });
  }

  async materialize(treeOid: string, destination: string): Promise<void> {
    const indexPath = path.join(this.workspace.sidecarRoot, "tmp", `materialize-${crypto.randomUUID()}.index`);
    await mkdir(destination, { recursive: true });
    try {
      await this.sidecarGit(["read-tree", treeOid], { env: this.indexEnv(indexPath) });
      const prefix = `${path.resolve(destination)}${path.sep}`;
      await this.sidecarGit([`--work-tree=${destination}`, "checkout-index", "--all", "--force", `--prefix=${prefix}`], {
        env: this.indexEnv(indexPath),
      });
    } finally {
      await rm(indexPath, { force: true });
    }
  }

  async diffNameStatus(fromTreeOid: string, toTreeOid: string): Promise<string[]> {
    const result = await this.sidecarGit([
      "diff-tree",
      "-r",
      "--no-commit-id",
      "--name-status",
      "--find-renames",
      "-z",
      fromTreeOid,
      toTreeOid,
    ]);
    return splitNull(result.stdout);
  }

  async diffTrees(fromTreeOid: string, toTreeOid: string): Promise<WorkspaceFileDiff[]> {
    const [nameStatus, numstat, fromEntries, toEntries] = await Promise.all([
      this.diffNameStatus(fromTreeOid, toTreeOid),
      this.sidecarGit([
        "diff-tree",
        "-r",
        "--no-commit-id",
        "--numstat",
        "--find-renames",
        "-z",
        fromTreeOid,
        toTreeOid,
      ]),
      this.listTree(fromTreeOid),
      this.listTree(toTreeOid),
    ]);
    const stats = this.parseNumstat(numstat.stdout);
    const oldByPath = new Map(fromEntries.map((entry) => [entry.path, entry]));
    const newByPath = new Map(toEntries.map((entry) => [entry.path, entry]));
    const files: WorkspaceFileDiff[] = [];
    for (let index = 0; index < nameStatus.length; ) {
      const code = nameStatus[index++]!;
      if (code.startsWith("R")) {
        const oldPath = nameStatus[index++]!;
        const newPath = nameStatus[index++]!;
        const stat = stats.get(newPath);
        const oldOid = oldByPath.get(oldPath)?.oid;
        const newOid = newByPath.get(newPath)?.oid;
        files.push({
          path: newPath,
          oldPath,
          status: "renamed",
          ...(oldOid ? { oldOid } : {}),
          ...(newOid ? { newOid } : {}),
          ...(stat?.additions === undefined ? {} : { additions: stat.additions }),
          ...(stat?.deletions === undefined ? {} : { deletions: stat.deletions }),
          binary: stat?.binary ?? false,
        });
        continue;
      }
      const filePath = nameStatus[index++]!;
      const stat = stats.get(filePath);
      const status = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
      const oldOid = oldByPath.get(filePath)?.oid;
      const newOid = newByPath.get(filePath)?.oid;
      files.push({
        path: filePath,
        status,
        ...(oldOid ? { oldOid } : {}),
        ...(newOid ? { newOid } : {}),
        ...(stat?.additions === undefined ? {} : { additions: stat.additions }),
        ...(stat?.deletions === undefined ? {} : { deletions: stat.deletions }),
        binary: stat?.binary ?? false,
      });
    }
    return files;
  }

  private parseNumstat(buffer: Buffer): Map<string, { additions?: number; deletions?: number; binary: boolean }> {
    const tokens = splitNull(buffer);
    const result = new Map<string, { additions?: number; deletions?: number; binary: boolean }>();
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      const match = /^([^\t]+)\t([^\t]+)\t(.*)$/.exec(token);
      if (!match) continue;
      let filePath = match[3]!;
      if (filePath === "" && index + 2 < tokens.length) {
        index++;
        filePath = tokens[++index]!;
      }
      const binary = match[1] === "-" || match[2] === "-";
      result.set(filePath, {
        ...(binary ? {} : { additions: Number(match[1]), deletions: Number(match[2]) }),
        binary,
      });
    }
    return result;
  }

  async patch(fromTreeOid: string, toTreeOid: string, paths?: readonly string[]): Promise<string> {
    const args = ["diff-tree", "-r", "--no-commit-id", "--find-renames", "--patch", fromTreeOid, toTreeOid];
    if (paths && paths.length > 0) args.push("--", ...paths);
    const result = await this.sidecarGit(args, { maxOutputBytes: 32 * 1024 * 1024 });
    return result.stdout.toString("utf8");
  }

  async planRestore(currentTreeOid: string, targetTreeOid: string): Promise<WorkspaceRestorePlan> {
    const [currentEntries, targetEntries] = await Promise.all([
      this.listTree(currentTreeOid),
      this.listTree(targetTreeOid),
    ]);
    const current = new Map(currentEntries.map((entry) => [entry.path, entry]));
    const target = new Map(targetEntries.map((entry) => [entry.path, entry]));
    const writes: string[] = [];
    const deletes: string[] = [];
    const collisions: string[] = [];
    const skippedGitlinks: string[] = [];

    for (const entry of currentEntries) {
      const desired = target.get(entry.path);
      if (!desired) {
        if (entry.mode === "160000") skippedGitlinks.push(entry.path);
        else {
          const absolute = path.join(this.workspace.rootPath, entry.path);
          if ((await exists(absolute)) && (await lstat(absolute)).isDirectory()) {
            collisions.push(`${entry.path}: expected a file but found a directory`);
          } else {
            deletes.push(entry.path);
          }
        }
      }
    }

    for (const entry of targetEntries) {
      const previous = current.get(entry.path);
      if (entry.mode === "160000" || previous?.mode === "160000") {
        if (!previous || previous.oid !== entry.oid || previous.mode !== entry.mode) skippedGitlinks.push(entry.path);
        continue;
      }
      if (previous?.oid === entry.oid && previous.mode === entry.mode) continue;
      const absolute = path.join(this.workspace.rootPath, entry.path);
      if ((await exists(absolute)) && !previous) {
        collisions.push(`${entry.path}: existing ignored or out-of-scope path would be overwritten`);
        continue;
      }
      if ((await exists(absolute)) && (await lstat(absolute)).isDirectory()) {
        collisions.push(`${entry.path}: directory would be replaced by a file`);
        continue;
      }
      let ancestor = path.dirname(absolute);
      while (ancestor !== this.workspace.rootPath && ancestor.startsWith(`${this.workspace.rootPath}${path.sep}`)) {
        if ((await exists(ancestor)) && !(await lstat(ancestor)).isDirectory()) {
          collisions.push(`${entry.path}: parent ${this.normalizePath(ancestor)} is not a directory`);
          break;
        }
        ancestor = path.dirname(ancestor);
      }
      writes.push(entry.path);
    }
    return {
      writes: [...new Set(writes)].sort(),
      deletes: [...new Set(deletes)].sort((a, b) => b.length - a.length),
      collisions: [...new Set(collisions)],
      skippedGitlinks: [...new Set(skippedGitlinks)],
    };
  }

  async restoreTree(currentTreeOid: string, targetTreeOid: string): Promise<WorkspaceRestorePlan> {
    const plan = await this.planRestore(currentTreeOid, targetTreeOid);
    if (plan.collisions.length > 0) {
      throw new Error(`Workspace restore refused:\n${plan.collisions.map((item) => `- ${item}`).join("\n")}`);
    }
    const temp = path.join(this.workspace.sidecarRoot, "tmp", `restore-${crypto.randomUUID()}`);
    try {
      await this.materialize(targetTreeOid, temp);
      await this.applyMaterializedPlan(temp, targetTreeOid, plan);
      return plan;
    } catch (error) {
      await this.rollbackTree(targetTreeOid, currentTreeOid).catch(() => undefined);
      throw error;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  private async applyMaterializedPlan(
    materializedRoot: string,
    targetTreeOid: string,
    plan: WorkspaceRestorePlan,
  ): Promise<void> {
    const targetEntries = new Map((await this.listTree(targetTreeOid)).map((entry) => [entry.path, entry]));
    for (const filePath of plan.deletes) {
      await rm(path.join(this.workspace.rootPath, filePath), { force: true });
    }
    for (const filePath of plan.writes) {
      const source = path.join(materializedRoot, filePath);
      const destination = path.join(this.workspace.rootPath, filePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await rm(destination, { recursive: true, force: true });
      const sourceStat = await lstat(source);
      if (sourceStat.isSymbolicLink()) {
        await symlink(await readlink(source), destination, "file");
      } else {
        await copyFile(source, destination);
        const mode = targetEntries.get(filePath)?.mode;
        if (mode === "100755") await chmod(destination, 0o755);
      }
    }
  }

  private async rollbackTree(fromTreeOid: string, toTreeOid: string): Promise<void> {
    const plan = await this.planRestore(fromTreeOid, toTreeOid);
    const temp = path.join(this.workspace.sidecarRoot, "tmp", `rollback-${crypto.randomUUID()}`);
    try {
      await this.materialize(toTreeOid, temp);
      await this.applyMaterializedPlan(temp, toTreeOid, { ...plan, collisions: [] });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  async mergeTrees(baseTreeOid: string, oursTreeOid: string, theirsTreeOid: string): Promise<WorkspaceMergeResult> {
    const result = await this.sidecarGit(
      [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        "-z",
        `--merge-base=${baseTreeOid}`,
        oursTreeOid,
        theirsTreeOid,
      ],
      { allowExitCodes: [0, 1] },
    );
    const output = splitNull(result.stdout);
    const treeOid = output.shift();
    if (!treeOid) throw new Error("git merge-tree did not return a result tree");
    const conflicts = [...new Set(output.filter(Boolean))];
    if (result.code === 1 || conflicts.length > 0) return { clean: false, conflicts };
    return { clean: true, treeOid, conflicts: [] };
  }

  async gc(): Promise<void> {
    await this.sidecarGit(["gc", "--prune=now"]);
  }

  async deleteSessionObjects(): Promise<void> {
    await this.sidecarGit(["update-ref", "-d", this.keepRef]);
    await rm(this.indexPath, { force: true });
    await this.gc();
  }

  normalizePath(filePath: string): string {
    return normalizeGitPath(path.relative(this.workspace.rootPath, path.resolve(filePath)));
  }
}
