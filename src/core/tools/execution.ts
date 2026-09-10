import path from "node:path";
import { isPathInside, realPath, resolveWorkspacePath } from "./path-safety.js";
import type { ToolContext } from "./types.js";

export type ToolEffect = "read" | "write" | "process" | "interactive";
export type ToolExecutionMode = "parallel" | "sequential";
export type ToolResourceAccess = "read" | "write";
export type ToolResourceScope = "exact" | "subtree";

/**
 * A scheduler-visible resource access. Claims are intentionally independent of
 * tool names: a read tool and a write tool conflict when they address the same
 * resource even if their implementations are unrelated.
 */
export interface ToolResourceClaim {
  namespace: "workspace" | "session-tree" | "skills" | "network" | "process" | "interactive" | string;
  resource: string;
  access: ToolResourceAccess;
  scope?: ToolResourceScope;
}

export interface ToolPlanningContext {
  readonly rootPath: string;
  readonly writableExternalPaths?: readonly string[];
  readonly signal: AbortSignal;
}

export interface ToolExecutionPolicy<TArgs extends Record<string, unknown>> {
  /** Read effects may start as soon as the streamed call is durable. Other effects wait for the complete response. */
  effect: ToolEffect;
  /** Sequential calls form a source-order barrier around every other call in the assistant batch. */
  mode: ToolExecutionMode;
  /** Resolve the resources used by this invocation after argument validation and extension transforms. */
  resources(args: TArgs, context: ToolPlanningContext): readonly ToolResourceClaim[] | Promise<readonly ToolResourceClaim[]>;
}

export function validateToolExecutionPolicy(policy: ToolExecutionPolicy<Record<string, unknown>>): void {
  if (!policy || !["read", "write", "process", "interactive"].includes(policy.effect)) {
    throw new Error("Tool execution.effect must be read, write, process, or interactive");
  }
  if (policy.mode !== "parallel" && policy.mode !== "sequential") {
    throw new Error("Tool execution.mode must be parallel or sequential");
  }
  if (typeof policy.resources !== "function") throw new Error("Tool execution.resources must be a function");
}

export function validateToolResourceClaims(claims: readonly ToolResourceClaim[]): readonly ToolResourceClaim[] {
  if (!Array.isArray(claims)) throw new Error("Tool execution.resources must return an array");
  return claims.map((value) => {
    if (!value || typeof value.namespace !== "string" || !value.namespace.trim()) {
      throw new Error("Tool resource namespace must be a non-empty string");
    }
    if (typeof value.resource !== "string" || !value.resource.trim()) {
      throw new Error("Tool resource identifier must be a non-empty string");
    }
    if (value.access !== "read" && value.access !== "write") {
      throw new Error("Tool resource access must be read or write");
    }
    if (value.scope !== undefined && value.scope !== "exact" && value.scope !== "subtree") {
      throw new Error("Tool resource scope must be exact or subtree");
    }
    return { ...value, scope: value.scope ?? "exact" };
  });
}

export function claim(
  namespace: ToolResourceClaim["namespace"],
  resource: string,
  access: ToolResourceAccess,
  scope: ToolResourceScope = "exact",
): ToolResourceClaim {
  return { namespace, resource, access, scope };
}

export function noResources(): readonly ToolResourceClaim[] {
  return [];
}

export function singletonResource(
  namespace: ToolResourceClaim["namespace"],
  resource: string,
  access: ToolResourceAccess,
  scope: ToolResourceScope = "exact",
): readonly ToolResourceClaim[] {
  return [claim(namespace, resource, access, scope)];
}

function normalizeResourcePath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function canonicalTarget(target: string): Promise<string> {
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

/** Resolve and canonicalize a workspace path for scheduler conflict detection. */
export async function workspacePathClaim(
  rootPath: string,
  inputPath: string,
  access: ToolResourceAccess,
  options: {
    forWrite?: boolean;
    allowOutside?: boolean;
    allowedOutsidePaths?: readonly string[];
    scope?: ToolResourceScope;
  } = {},
): Promise<ToolResourceClaim> {
  const target = await resolveWorkspacePath(rootPath, inputPath, {
    forWrite: options.forWrite === true,
    allowOutside: options.allowOutside === true,
    ...(options.allowedOutsidePaths ? { allowedOutsidePaths: options.allowedOutsidePaths } : {}),
  });
  return claim("workspace", normalizeResourcePath(await canonicalTarget(target)), access, options.scope ?? "exact");
}

/** Preserve ordinary relative paths for display, but resolve aliases before host authorization. */
export async function prepareFilePath<T extends Record<string, unknown> & { path?: string }>(
  args: T, context: ToolPlanningContext, options: { forWrite?: boolean; defaultPath?: string; literal?: boolean } = {},
): Promise<T & { path: string }> {
  context.signal.throwIfAborted();
  const input = (options.literal ? args.path : args.path?.trim()) || options.defaultPath;
  if (!input) throw new Error("path cannot be empty");
  const root = await realPath(context.rootPath);
  const target = await canonicalTarget(await resolveWorkspacePath(root, input, {
    forWrite: options.forWrite === true,
    allowOutside: options.forWrite !== true,
    ...(context.writableExternalPaths ? { allowedOutsidePaths: context.writableExternalPaths } : {}),
  }));
  context.signal.throwIfAborted();
  return { ...args, path: path.isAbsolute(input) || !isPathInside(root, target) ? target : path.relative(root, target) || "." };
}

/** Recheck the actual target, including after a write waits for another editor. */
export async function resolveToolPath(context: ToolContext, input: string, forWrite = false): Promise<string> {
  context.signal.throwIfAborted();
  const target = await resolveWorkspacePath(context.rootPath, input, {
    forWrite, allowOutside: !forWrite,
    ...(context.writableExternalPaths ? { allowedOutsidePaths: context.writableExternalPaths } : {}),
  });
  if (context.resources) {
    const actual = normalizeResourcePath(await canonicalTarget(target));
    const approved = context.resources.some((resource) => resource.namespace === "workspace" &&
      (!forWrite || resource.access === "write") && (resource.resource === "*" ||
        (resource.scope === "subtree" ? isPathInside(resource.resource, actual) : resource.resource === actual)));
    if (!approved) throw new Error(`File target changed outside the approved resources: ${input}`);
  }
  return target;
}

/** A conservative claim for tools, such as a shell, whose workspace effects cannot be enumerated. */
export function entireWorkspaceClaim(access: ToolResourceAccess): ToolResourceClaim {
  return claim("workspace", "*", access, "subtree");
}
