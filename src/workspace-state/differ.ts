import { sha256 } from "../utils/id.js";
import {
  WORKSPACE_CHANGE_SET_FORMAT,
  type WorkspaceChangeSet,
  type WorkspaceEntry,
  type WorkspaceOperation,
  type WorkspaceScope,
  type WorkspaceState,
} from "./model.js";

function sameEntry(left: WorkspaceEntry | undefined, right: WorkspaceEntry | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inScope(path: string, scopes: readonly WorkspaceScope[]): boolean {
  return scopes.some((scope) => scope.kind === "file"
    ? path === scope.path
    : path === scope.path || path.startsWith(`${scope.path}/`));
}

function operationInScope(operation: WorkspaceOperation, scopes: readonly WorkspaceScope[]): boolean {
  if (inScope(operation.path, scopes)) return true;
  return operation.kind === "create" && operation.after.kind === "directory" &&
    scopes.some((scope) => scope.path.startsWith(`${operation.path}/`));
}

export class WorkspaceDiffer {
  createChangeSet(
    taskId: string,
    base: WorkspaceState,
    result: WorkspaceState,
    scopes: readonly WorkspaceScope[],
  ): WorkspaceChangeSet {
    const before = new Map(base.entries.map((entry) => [entry.path, entry]));
    const after = new Map(result.entries.map((entry) => [entry.path, entry]));
    const operations: WorkspaceOperation[] = [];
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const oldEntry = before.get(path);
      const newEntry = after.get(path);
      if (sameEntry(oldEntry, newEntry)) continue;
      if (!oldEntry && newEntry) operations.push({ kind: "create", path, after: structuredClone(newEntry) });
      else if (oldEntry && !newEntry) operations.push({ kind: "delete", path, before: structuredClone(oldEntry) });
      else operations.push({ kind: "modify", path, before: structuredClone(oldEntry!), after: structuredClone(newEntry!) });
    }
    const scopeViolations = operations.filter((operation) => !operationInScope(operation, scopes)).map((operation) => operation.path);
    const body = {
      format: WORKSPACE_CHANGE_SET_FORMAT,
      formatVersion: 1 as const,
      taskId,
      baseStateId: base.id,
      resultStateId: result.id,
      operations,
      scopeViolations,
    };
    return { ...body, id: `change_${sha256(JSON.stringify(body))}` };
  }

  scopesOverlap(left: readonly WorkspaceScope[], right: readonly WorkspaceScope[]): boolean {
    return left.some((first) => right.some((second) =>
      inScope(first.path, [second]) || inScope(second.path, [first])
    ));
  }
}
