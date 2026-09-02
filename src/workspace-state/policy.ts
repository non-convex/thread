import type { WorkspaceStatePolicy } from "./model.js";

/** Directory names omitted from checkpoints as metadata or reproducible dependencies, output, and caches. */
export const DEFAULT_WORKSPACE_EXCLUDED_DIRECTORY_NAMES = [
  ".build",
  ".cache",
  ".dart_tool",
  ".git",
  ".gradle",
  ".mypy_cache",
  ".next",
  ".nox",
  ".nuxt",
  ".nx",
  ".output",
  ".parcel-cache",
  ".pytest_cache",
  ".ruff_cache",
  ".svelte-kit",
  ".thread",
  ".tox",
  ".turbo",
  ".venv",
  "__pycache__",
  "bower_components",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv",
] as const;

export class WorkspacePathExclusions {
  private readonly directoryNames: ReadonlySet<string>;

  constructor(private readonly policy: WorkspaceStatePolicy) {
    this.directoryNames = new Set(policy.excludedDirectoryNames);
  }

  matches(relativePath: string, excludeLeafName: boolean): boolean {
    if (this.policy.excludedPaths.some((prefix) =>
      relativePath === prefix || relativePath.startsWith(`${prefix}/`)
    )) return true;

    const segments = relativePath.split("/");
    const checkedSegmentCount = excludeLeafName ? segments.length : segments.length - 1;
    for (let index = 0; index < checkedSegmentCount; index++) {
      if (this.directoryNames.has(segments[index]!)) return true;
    }
    return false;
  }
}
