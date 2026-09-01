import { realpath } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "./path-safety.js";

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
  rootPath: string;
  signal: AbortSignal;
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
    return normalizeResourcePath(await realpath(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const missing: string[] = [];
  let parent = target;
  while (true) {
    missing.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) return normalizeResourcePath(target);
    parent = next;
    try {
      return normalizeResourcePath(path.join(await realpath(parent), ...missing));
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
  options: { forWrite?: boolean; scope?: ToolResourceScope } = {},
): Promise<ToolResourceClaim> {
  const target = await resolveWorkspacePath(rootPath, inputPath, options.forWrite === true);
  return claim("workspace", await canonicalTarget(target), access, options.scope ?? "exact");
}

/** A conservative claim for tools, such as a shell, whose workspace effects cannot be enumerated. */
export function entireWorkspaceClaim(access: ToolResourceAccess): ToolResourceClaim {
  return claim("workspace", "*", access, "subtree");
}
