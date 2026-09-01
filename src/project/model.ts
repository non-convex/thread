export const PROJECT_FORMAT = "thread-project-v1" as const;

export interface Project {
  id: string;
  rootPath: string;
  statePath: string;
}

export interface ProjectManifest {
  format: typeof PROJECT_FORMAT;
  formatVersion: 1;
  id: string;
  rootPath: string;
  createdAt: number;
}
