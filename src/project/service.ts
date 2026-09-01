import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getThreadHome } from "../config/thread-config.js";
import { stableId } from "../utils/id.js";
import { discoverProjectRoot } from "./discovery.js";
import { PROJECT_FORMAT, type Project, type ProjectManifest } from "./model.js";

function normalizedIdentity(rootPath: string): string {
  const normalized = path.resolve(rootPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parseManifest(value: unknown, manifestPath: string): ProjectManifest {
  if (typeof value !== "object" || value === null) throw new Error(`Invalid project manifest: ${manifestPath}`);
  const manifest = value as Partial<ProjectManifest>;
  if (manifest.format !== PROJECT_FORMAT || manifest.formatVersion !== 1) {
    throw new Error(`Unsupported Thread project data at ${manifestPath}; old data is not migrated or loaded`);
  }
  if (typeof manifest.id !== "string" || typeof manifest.rootPath !== "string" ||
      typeof manifest.createdAt !== "number") {
    throw new Error(`Incomplete project manifest: ${manifestPath}`);
  }
  return manifest as ProjectManifest;
}

export class ProjectService {
  static async open(rootInput: string): Promise<Project> {
    const rootPath = await discoverProjectRoot(rootInput);
    const id = stableId("project", normalizedIdentity(rootPath));
    const statePath = path.join(getThreadHome(), "projects", id);
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
      const manifest: ProjectManifest = {
        format: PROJECT_FORMAT,
        formatVersion: 1,
        id,
        rootPath,
        createdAt: Date.now(),
      };
      const temporary = `${manifestPath}.tmp-${process.pid}`;
      try {
        await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
        await rename(temporary, manifestPath);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    return { id, rootPath, statePath };
  }
}
