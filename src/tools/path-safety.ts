import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export interface ResolvePathOptions {
  forWrite?: boolean;
  /** Read tools may inspect files outside the project; writes stay confined. */
  allowOutside?: boolean;
  /** Exact external files that a caller may write without opening their parent directory. */
  allowedOutsidePaths?: readonly string[];
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

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(comparable(root), comparable(candidate));
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function samePath(left: string, right: string): boolean {
  return comparable(left) === comparable(right);
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

function confine(root: string, candidate: string, inputPath: string, kind: "path" | "resolved" | "parent"): void {
  if (isPathInside(root, candidate)) return;
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
  const root = await realPath(rootPath);
  const absolute = path.resolve(root, inputPath);
  const externalAllowed = !isPathInside(root, absolute) &&
    (options.allowedOutsidePaths ?? []).some((candidate) => samePath(path.resolve(candidate), absolute));
  if (!allowOutside && !externalAllowed) confine(root, absolute, inputPath, "path");
  try {
    const stat = await lstat(absolute);
    if (forWrite && stat.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${inputPath}`);
    const resolved = await realPath(absolute);
    if (externalAllowed && !samePath(resolved, absolute)) {
      throw new Error(`Path resolves outside the allowed external file: ${inputPath}`);
    }
    if (!allowOutside && !externalAllowed) confine(root, resolved, inputPath, "resolved");
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
          confine(root, resolvedParent, inputPath, "parent");
        }
        if (forWrite) return path.join(resolvedParent, suffix);
        break;
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
        const next = path.dirname(parent);
        if (next === parent || (!externalAllowed && !isPathInside(root, next))) {
          throw new Error(`No workspace parent exists for: ${inputPath}`);
        }
        suffix = path.join(path.basename(parent), suffix);
        parent = next;
      }
    }
  }
  return absolute;
}
