export const WORKSPACE_STATE_FORMAT = "thread-workspace-state-v2" as const;

export interface WorkspaceStatePolicy {
  /** Paths are project-relative, slash-separated directory prefixes. */
  excludedPaths: string[];
  /** Directory basenames excluded at every depth of the project. */
  excludedDirectoryNames: string[];
  /** `.gitignore` is not otherwise used to define checkpoint contents. */
  includeIgnoredFiles: true;
  includeProjectMetadata: false;
}

export type WorkspaceEntry =
  | { path: string; kind: "directory"; mode: number }
  | { path: string; kind: "file"; mode: number; size: number; blobId: string }
  | { path: string; kind: "symlink"; mode: number; target: string };

export interface WorkspaceState {
  format: typeof WORKSPACE_STATE_FORMAT;
  formatVersion: 2;
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
