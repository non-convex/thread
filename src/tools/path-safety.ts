import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export async function resolveWorkspacePath(rootPath: string, inputPath: string, forWrite = false): Promise<string> {
  const root = await realpath(rootPath);
  const absolute = path.resolve(root, inputPath);
  if (!inside(root, absolute)) throw new Error(`Path is outside workspace: ${inputPath}`);
  try {
    const stat = await lstat(absolute);
    if (forWrite && stat.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${inputPath}`);
    const resolved = await realpath(absolute);
    if (!inside(root, resolved)) throw new Error(`Path resolves outside workspace: ${inputPath}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    let parent = path.dirname(absolute);
    while (true) {
      try {
        const resolvedParent = await realpath(parent);
        if (!inside(root, resolvedParent)) throw new Error(`Parent resolves outside workspace: ${inputPath}`);
        break;
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
        const next = path.dirname(parent);
        if (next === parent || !inside(root, next)) throw new Error(`No workspace parent exists for: ${inputPath}`);
        parent = next;
      }
    }
  }
  return absolute;
}
