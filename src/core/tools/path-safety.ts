import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export interface ResolvePathOptions {
  forWrite?: boolean;
  /** Read tools may inspect files outside the project; writes stay confined. */
  allowOutside?: boolean;
  /** Exact external files that a caller may write without opening their parent directory. */
  allowedOutsidePaths?: readonly string[];
  /** External directory trees that a caller may write. */
  allowedOutsideDirectories?: readonly string[];
}

/** Workspace-relative paths writable through the built-in file tools. */
export interface FileWriteScope {
  path: string;
  kind: "file" | "directory";
}

function comparable(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Bun on Windows can return a bare drive letter for a volume root. */
export async function realPath(target: string): Promise<string> {
  const resolved = await realpath(target);
  return process.platform === "win32" && /^[A-Za-z]:$/.test(resolved) ? `${resolved}\\` : resolved;
}

/** Resolve existing ancestors without requiring the target to exist. */
export async function canonicalTarget(target: string): Promise<string> {
  try {
    return await realPath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const missing: string[] = [];
  let parent = target;
  while (true) {
    missing.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) return path.normalize(target);
    parent = next;
    try {
      return path.join(await realPath(parent), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(comparable(root), comparable(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function samePath(left: string, right: string): boolean {
  return comparable(left) === comparable(right);
}

/** Protected state takes precedence over workspace and external write grants. */
export async function assertWritablePath(target: string, protectedPaths: readonly string[] = []): Promise<void> {
  for (const protectedPath of protectedPaths) {
    if (isPathInside(await canonicalTarget(protectedPath), target)) {
      throw new Error(`Built-in file tools cannot modify protected runtime state: ${target}`);
    }
  }
}

/** Compare the resolved target to declared paths; directory aliases cannot expand a scope. */
export async function assertFileWriteScope(rootPath: string, target: string, scopes: readonly FileWriteScope[]): Promise<void> {
  const root = await realPath(rootPath);
  const allowed = scopes.some((scope) => {
    const boundary = path.resolve(root, scope.path);
    if (!isPathInside(root, boundary)) return false;
    return scope.kind === "file" ? samePath(boundary, target)
      : scope.kind === "directory" && isPathInside(boundary, target);
  });
  if (!allowed) throw new Error(`File write is outside the declared write scope: ${path.relative(root, target)}. Use a path assigned to this task.`);
}

function confine(root: string, candidate: string, inputPath: string, kind: "path" | "resolved" | "parent", location = "workspace"): void {
  if (isPathInside(root, candidate)) return;
  if (kind === "resolved") throw new Error(`Path resolves outside ${location}: ${inputPath}`);
  if (kind === "parent") throw new Error(`Parent resolves outside ${location}: ${inputPath}`);
  throw new Error(`Path is outside ${location}: ${inputPath}`);
}

export async function resolveWorkspacePath(
  rootPath: string,
  inputPath: string,
  options: ResolvePathOptions = {},
): Promise<string> {
  const forWrite = options.forWrite === true;
  const allowOutside = options.allowOutside === true;
  const root = await realPath(rootPath);
  const absolute = path.resolve(root, inputPath);
  const externalAllowed = !isPathInside(root, absolute) &&
    (options.allowedOutsidePaths ?? []).some((candidate) => samePath(path.resolve(candidate), absolute));
  let writeRoot = root;
  let externalDirectory = false;
  if (!allowOutside && !externalAllowed && !isPathInside(root, absolute)) {
    for (const directory of options.allowedOutsideDirectories ?? []) {
      const declared = path.resolve(directory);
      const resolved = await canonicalTarget(declared);
      if (isPathInside(declared, absolute) || isPathInside(resolved, absolute)) {
        writeRoot = resolved;
        externalDirectory = true;
        break;
      }
    }
    if (!externalDirectory) confine(root, absolute, inputPath, "path");
  }
  const location = externalDirectory ? "the allowed external directory" : "workspace";
  try {
    const stat = await lstat(absolute);
    if (forWrite && stat.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${inputPath}`);
    const resolved = await realPath(absolute);
    if (externalAllowed && !samePath(resolved, absolute)) {
      throw new Error(`Path resolves outside the allowed external file: ${inputPath}`);
    }
    if (!allowOutside && !externalAllowed) confine(writeRoot, resolved, inputPath, "resolved", location);
    if (forWrite) return resolved;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    if (allowOutside) return absolute;
    let parent = path.dirname(absolute);
    let suffix = path.basename(absolute);
    while (true) {
      try {
        const resolvedParent = await realPath(parent);
        if (externalAllowed) {
          if (!samePath(path.join(resolvedParent, suffix), absolute)) {
            throw new Error(`Parent resolves outside the allowed external file: ${inputPath}`);
          }
        } else {
          // The allowed directory itself may not exist yet; check the complete target.
          confine(writeRoot, path.join(resolvedParent, suffix), inputPath, "parent", location);
        }
        if (forWrite) return path.join(resolvedParent, suffix);
        break;
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
        const next = path.dirname(parent);
        if (next === parent) {
          throw new Error(`No workspace parent exists for: ${inputPath}`);
        }
        suffix = path.join(path.basename(parent), suffix);
        parent = next;
      }
    }
  }
  return absolute;
}
