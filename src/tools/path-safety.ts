import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export interface ResolvePathOptions {
  forWrite?: boolean;
  /** Read tools may inspect files outside the project; writes stay confined. */
  allowOutside?: boolean;
  /** Exact external files that a caller may write without opening their parent directory. */
  allowedOutsidePaths?: readonly string[];
}

function comparable(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function inside(root: string, candidate: string): boolean {
  const normalizedRoot = comparable(root);
  const normalizedCandidate = comparable(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function samePath(left: string, right: string): boolean {
  return comparable(left) === comparable(right);
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
  const externalAllowed = !inside(root, absolute) &&
    (options.allowedOutsidePaths ?? []).some((candidate) => samePath(path.resolve(candidate), absolute));
  if (!allowOutside && !externalAllowed) confine(root, absolute, inputPath, "path");
  try {
    const stat = await lstat(absolute);
    if (forWrite && stat.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${inputPath}`);
    const resolved = await realpath(absolute);
    if (externalAllowed && !samePath(resolved, absolute)) {
      throw new Error(`Path resolves outside the allowed external file: ${inputPath}`);
    }
    if (!allowOutside && !externalAllowed) confine(root, resolved, inputPath, "resolved");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    if (allowOutside) return absolute;
    let parent = path.dirname(absolute);
    let suffix = path.basename(absolute);
    while (true) {
      try {
        const resolvedParent = await realpath(parent);
        if (externalAllowed) {
          if (!samePath(path.join(resolvedParent, suffix), absolute)) {
            throw new Error(`Parent resolves outside the allowed external file: ${inputPath}`);
          }
        } else {
          confine(root, resolvedParent, inputPath, "parent");
        }
        break;
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw parentError;
        const next = path.dirname(parent);
        if (next === parent || (!externalAllowed && !inside(root, next))) {
          throw new Error(`No workspace parent exists for: ${inputPath}`);
        }
        suffix = path.join(path.basename(parent), suffix);
        parent = next;
      }
    }
  }
  return absolute;
}
