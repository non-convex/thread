export const PROJECT_FORMAT = "thread-project-v2" as const;

export interface Project {
  id: string;
  rootPath: string;
  statePath: string;
}

export interface ProjectManifest {
  format: typeof PROJECT_FORMAT;
  formatVersion: 2;
  id: string;
  rootPath: string;
  createdAt: number;
}
