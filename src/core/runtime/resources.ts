import path from "node:path";
import { AgentTaskRepository } from "../agent-task/repository.js";
import { getThreadHome } from "../config/home.js";
import { FileHistoryService } from "../file-history/service.js";
import { GlobalMemorySnapshots } from "../global-memory.js";
import type { Project } from "../project/model.js";
import { ProjectService } from "../project/service.js";
import { SessionRecallService } from "../session-recall/service.js";
import { SessionTreeRepository } from "../session-tree/repository.js";
import { SessionTreeService } from "../session-tree/service.js";
import { loadSkills, type LoadedSkills } from "../skills/loader.js";
import type { RuntimeOptionsSnapshot } from "./options.js";

export interface RuntimeResources {
  project: Project;
  repository: SessionTreeRepository;
  tree: SessionTreeService;
  fileHistory: FileHistoryService;
  skills: LoadedSkills;
  recall: SessionRecallService | undefined;
  taskRepository: AgentTaskRepository;
  memory: GlobalMemorySnapshots | undefined;
}

/** Startup acquires project resources; ThreadRuntime owns them after this returns. */
export async function openRuntimeResources(options: RuntimeOptionsSnapshot): Promise<RuntimeResources> {
  const project = await ProjectService.open(options.rootPath, options.stateDirectory ? { stateDirectory: options.stateDirectory } : {});
  const skills = options.skills && "paths" in options.skills
    ? await loadSkills(options.skills.paths.map((directory) => path.resolve(project.rootPath, directory)))
    : options.skills ?? { skills: [], diagnostics: [] };
  let repository: SessionTreeRepository | undefined;
  let taskRepository: AgentTaskRepository | undefined;
  let recall: SessionRecallService | undefined;
  try {
    repository = await SessionTreeRepository.open(project);
    const tree = new SessionTreeService(repository);
    await tree.initialize();
    const memory = options.globalMemoryPath
      ? await GlobalMemorySnapshots.open([...tree.projection.sessions.keys()], path.resolve(options.globalMemoryPath)) : undefined;
    const fileHistory = new FileHistoryService(project, tree,
      [options.stateDirectory ?? getThreadHome(), ...(memory ? [memory.filePath] : [])], options.fileCheckpoints ?? false);
    recall = options.search ? new SessionRecallService(tree, options.search) : undefined;
    taskRepository = await AgentTaskRepository.open(project);
    return { project, repository, tree, fileHistory, skills, recall, taskRepository, memory };
  } catch (error) {
    await Promise.allSettled([recall?.close(), taskRepository?.close(), repository?.close()]);
    throw error;
  }
}
