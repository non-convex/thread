import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export interface ResolvePathOptions {
  forWrite?: boolean;
  /** Read tools may inspect files outside the project; writes stay confined. */
  allowOutside?: boolean;
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function confine(root: string, candidate: string, inputPath: string, kind: "path" | "resolved" | "parent"): void {
  if (inside(root, candidate)) return;
  if (kind === "resolved") throw new Error(`Path resolves outside workspace: ${inputPath}`);
  if (kind === "parent") throw new Error(`Parent resolves outside workspace: ${inputPath}`);
  throw new Error(`Path is outside workspace: ${inputPath}`);
}

export async function resolveWorkspacePath(
  rootPath: string,
  inputPath: string,
  options: ResolvePathOptions = {},
): Promise<string> {
  const forWrite = options.forWrite === true;
  const allowOutside = options.allowOutside === true;
  const root = await realpath(rootPath);
  const absolute = path.resolve(root, inputPath);
  if (!allowOutside) confine(root, absolute, inputPath, "path");
  try {
    const stat = await lstat(absolute);
    if (forWrite && stat.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${inputPath}`);
    const resolved = await realpath(absolute);
    if (!allowOutside) confine(root, resolved, inputPath, "resolved");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    if (allowOutside) return absolute;
    let parent = path.dirname(absolute);
    while (true) {
      try {
        const resolvedParent = await realpath(parent);
        confine(root, resolvedParent, inputPath, "parent");
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
