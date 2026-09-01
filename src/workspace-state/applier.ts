import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceChangeSet, WorkspaceEntry, WorkspaceMergeConflict, WorkspaceState } from "./model.js";
import { WorkspaceApplyRaceError, type WorkspaceMaterializer } from "./materializer.js";
import type { WorkspaceSnapshotter } from "./snapshotter.js";
import type { WorkspaceStateStore } from "./store.js";

function same(left: WorkspaceEntry | undefined, right: WorkspaceEntry | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class WorkspaceChangeApplier {
  private readonly recoveryPath: string;

  constructor(
    private readonly rootPath: string,
    private readonly store: WorkspaceStateStore,
    private readonly snapshotter: WorkspaceSnapshotter,
    private readonly materializer: WorkspaceMaterializer,
  ) {
    this.recoveryPath = path.join(store.project.statePath, "workspace-states", "apply-recovery");
  }

  async recover(): Promise<void> {
    await mkdir(this.recoveryPath, { recursive: true });
    for (const name of await readdir(this.recoveryPath)) {
      if (!name.endsWith(".json")) continue;
      const target = path.join(this.recoveryPath, name);
      const record = JSON.parse(await readFile(target, "utf8")) as { currentStateId?: unknown };
      if (typeof record.currentStateId !== "string") throw new Error(`Invalid workspace recovery record: ${target}`);
      await this.materializer.materialize(record.currentStateId, this.rootPath);
      await rm(target, { force: true });
    }
  }

  async apply(changeSet: WorkspaceChangeSet): Promise<{ currentStateId: string; mergedStateId: string; conflicts: WorkspaceMergeConflict[] }> {
    if (changeSet.scopeViolations.length) throw new Error(`ChangeSet contains out-of-scope paths: ${changeSet.scopeViolations.join(", ")}`);
    const [base, result, current] = await Promise.all([
      this.store.read(changeSet.baseStateId),
      this.store.read(changeSet.resultStateId),
      this.snapshotter.capture(this.rootPath),
    ]);
    const baseEntries = new Map(base.entries.map((entry) => [entry.path, entry]));
    const resultEntries = new Map(result.entries.map((entry) => [entry.path, entry]));
    const currentEntries = new Map(current.entries.map((entry) => [entry.path, entry]));
    const conflicts: WorkspaceMergeConflict[] = [];
    for (const operation of changeSet.operations) {
      const before = baseEntries.get(operation.path);
      const child = resultEntries.get(operation.path);
      const parent = currentEntries.get(operation.path);
      if (same(parent, before) || same(parent, child)) continue;
      conflicts.push({
        path: operation.path,
        reason: before === undefined ? "parent-created" : parent === undefined ? "parent-deleted" : "parent-modified",
      });
    }
    const replacedDirectories = changeSet.operations.filter((operation) =>
      operation.kind !== "create" && operation.before.kind === "directory" &&
      (operation.kind === "delete" || operation.after.kind !== "directory")
    );
    for (const directory of replacedDirectories) {
      for (const [entryPath, parent] of currentEntries) {
        if (!entryPath.startsWith(`${directory.path}/`)) continue;
        const before = baseEntries.get(entryPath);
        const child = resultEntries.get(entryPath);
        if (same(parent, before) || same(parent, child)) continue;
        if (!conflicts.some((conflict) => conflict.path === entryPath)) {
          conflicts.push({ path: entryPath, reason: before === undefined ? "parent-created" : "parent-modified" });
        }
      }
    }
    if (conflicts.length) return { currentStateId: current.id, mergedStateId: current.id, conflicts };

    const mergedEntries = new Map(current.entries.map((entry) => [entry.path, structuredClone(entry)]));
    for (const operation of changeSet.operations) {
      if (operation.kind === "delete") mergedEntries.delete(operation.path);
      else mergedEntries.set(operation.path, structuredClone(operation.after));
    }
    const entries = [...mergedEntries.values()].sort((left, right) => left.path.localeCompare(right.path));
    const merged: WorkspaceState = {
      ...current,
      id: this.store.stateId(entries),
      capturedAt: Date.now(),
      entries,
    };
    await this.store.persist(merged);
    const latest = await this.snapshotter.capture(this.rootPath);
    if (latest.id !== current.id) {
      return {
        currentStateId: latest.id,
        mergedStateId: merged.id,
        conflicts: [{ path: "*", reason: "parent-modified" }],
      };
    }
    const recoveryFile = path.join(this.recoveryPath, `${changeSet.id}-${crypto.randomUUID()}.json`);
    await mkdir(this.recoveryPath, { recursive: true });
    await writeFile(recoveryFile, `${JSON.stringify({
      format: "thread-workspace-apply-recovery-v1",
      changeSetId: changeSet.id,
      currentStateId: current.id,
      mergedStateId: merged.id,
      createdAt: Date.now(),
    })}\n`, "utf8");
    try {
      await this.materializer.applyOperations(changeSet.operations, this.rootPath, currentEntries);
      const verified = await this.snapshotter.capture(this.rootPath);
      const verifiedEntries = new Map(verified.entries.map((entry) => [entry.path, entry]));
      for (const operation of changeSet.operations) {
        if (!same(verifiedEntries.get(operation.path), resultEntries.get(operation.path))) {
          throw new Error(`Applied workspace does not match the child result at ${operation.path}`);
        }
      }
      await rm(recoveryFile, { force: true });
      return { currentStateId: current.id, mergedStateId: verified.id, conflicts: [] };
    } catch (cause) {
      try {
        await this.materializer.restoreState(current, this.rootPath);
        await rm(recoveryFile, { force: true });
      } catch (rollback) {
        throw new AggregateError([cause, rollback], `Workspace apply and rollback both failed; recovery retained at ${recoveryFile}`);
      }
      if (cause instanceof WorkspaceApplyRaceError) {
        return {
          currentStateId: current.id,
          mergedStateId: merged.id,
          conflicts: [{ path: cause.path, reason: "parent-modified" }],
        };
      }
      throw cause;
    }
  }
}
