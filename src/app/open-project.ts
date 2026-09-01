import type { Project } from "../project/model.js";
import { ProjectService } from "../project/service.js";

export function openProject(rootPath: string): Promise<Project> {
  return ProjectService.open(rootPath);
}
