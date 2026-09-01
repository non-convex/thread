export const WORKSPACE_STATE_FORMAT = "thread-workspace-state-v1" as const;

export interface WorkspaceStatePolicy {
  /** Paths are project-relative, slash-separated directory prefixes. */
  excludedPaths: string[];
  includeIgnoredFiles: true;
  includeProjectMetadata: false;
}

export type WorkspaceEntry =
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "file"; mode: number; size: number; blobId: string }
  | { path: string; kind: "symlink"; mode: number; target: string };

export interface WorkspaceState {
  format: typeof WORKSPACE_STATE_FORMAT;
  formatVersion: 1;
  id: string;
  projectId: string;
  capturedAt: number;
  policy: WorkspaceStatePolicy;
  entries: WorkspaceEntry[];
}

export interface StagedWorkspaceState {
  /** Immutable metadata available as soon as the workspace scan completes. */
  state: WorkspaceState;
  /** Resolves only after blobs, manifest, and integrity verification are durable. */
  persisted: Promise<WorkspaceState>;
}

export const WORKSPACE_CHANGE_SET_FORMAT = "thread-change-set-v1" as const;

export type WorkspaceScope = {
  path: string;
  kind: "file" | "subtree";
};

export type WorkspaceOperation =
  | { kind: "create"; path: string; after: WorkspaceEntry }
  | { kind: "modify"; path: string; before: WorkspaceEntry; after: WorkspaceEntry }
  | { kind: "delete"; path: string; before: WorkspaceEntry };

export interface WorkspaceChangeSet {
  format: typeof WORKSPACE_CHANGE_SET_FORMAT;
  formatVersion: 1;
  id: string;
  taskId: string;
  baseStateId: string;
  resultStateId: string;
  operations: WorkspaceOperation[];
  scopeViolations: string[];
}

export interface WorkspaceMergeConflict {
  path: string;
  reason: "parent-modified" | "parent-created" | "parent-deleted";
}
