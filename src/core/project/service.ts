import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getThreadHome } from "../config/home.js";
import { stableId } from "../utils/id.js";
import { PROJECT_FORMAT, type Project, type ProjectManifest } from "./model.js";

function normalizedIdentity(rootPath: string): string {
  const normalized = path.resolve(rootPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parseManifest(value: unknown, manifestPath: string): ProjectManifest {
  if (typeof value !== "object" || value === null) throw new Error(`Invalid project manifest: ${manifestPath}`);
  const manifest = value as Partial<ProjectManifest>;
  if (manifest.format !== PROJECT_FORMAT || manifest.formatVersion !== 2) {
    throw new Error(`Unsupported Thread project data at ${manifestPath}; old data is not migrated or loaded`);
  }
  if (typeof manifest.id !== "string" || typeof manifest.rootPath !== "string" ||
      typeof manifest.createdAt !== "number") {
    throw new Error(`Incomplete project manifest: ${manifestPath}`);
  }
  return manifest as ProjectManifest;
}

export class ProjectService {
  static async resolve(rootInput: string, options: { stateDirectory?: string } = {}): Promise<Project> {
    const rootPath = path.resolve(rootInput);
    const info = await stat(rootPath).catch((error: NodeJS.ErrnoException) => {
      throw error.code === "ENOENT" ? new Error(`Project root does not exist: ${rootPath}`) : error;
    });
    if (!info.isDirectory()) throw new Error(`Project root is not a directory: ${rootPath}`);
    const id = stableId("project", normalizedIdentity(rootPath));
    const statePath = options.stateDirectory
      ? path.resolve(options.stateDirectory)
      : path.join(getThreadHome(), "projects", id);
    return { id, rootPath, statePath };
  }

  static async open(rootInput: string, options: { stateDirectory?: string } = {}): Promise<Project> {
    const project = await ProjectService.resolve(rootInput, options);
    const { id, rootPath, statePath } = project;
    const manifestPath = path.join(statePath, "project.json");
    await mkdir(statePath, { recursive: true });
    let existing: ProjectManifest | undefined;
    try {
      existing = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown, manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      if (existing.id !== id || normalizedIdentity(existing.rootPath) !== normalizedIdentity(rootPath)) {
        throw new Error(`Project manifest identity does not match ${rootPath}`);
      }
    } else {
      const manifest: ProjectManifest = { format: PROJECT_FORMAT, formatVersion: 2, id, rootPath, createdAt: Date.now() };
      const temporary = `${manifestPath}.tmp-${process.pid}`;
      try {
        await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        await rename(temporary, manifestPath);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    return project;
  }
}
