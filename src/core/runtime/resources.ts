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
import { canonicalTarget } from "../tools/path-safety.js";
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
  protectedWritePaths: readonly string[];
}

/** Startup acquires project resources; ThreadRuntime owns them after this returns. */
export async function openRuntimeResources(options: RuntimeOptionsSnapshot): Promise<RuntimeResources> {
  const project = await ProjectService.open(options.rootPath, options.stateDirectory ? { stateDirectory: options.stateDirectory } : {});
  const declaredProtectedPaths = [project.statePath, ...(options.protectedWritePaths ?? [])];
  // Keep both configured aliases and their startup targets protected if an alias later changes.
  const protectedWritePaths = [...new Set([...declaredProtectedPaths, ...await Promise.all(declaredProtectedPaths.map(canonicalTarget))])];
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
      [options.stateDirectory ?? getThreadHome(), ...protectedWritePaths, ...(memory ? [memory.filePath] : [])], options.fileCheckpoints ?? false);
    // A committed rewind intent is completed before any host or agent can use
    // the project again, even if checkpoints were disabled on this new open.
    await fileHistory.resumePendingRewind();
    recall = options.search ? new SessionRecallService(tree, options.search) : undefined;
    taskRepository = await AgentTaskRepository.open(project);
    return { project, repository, tree, fileHistory, skills, recall, taskRepository, memory, protectedWritePaths };
  } catch (error) {
    await Promise.allSettled([recall?.close(), taskRepository?.close(), repository?.close()]);
    throw error;
  }
}
