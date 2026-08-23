import { runProcess, type ProcessResult } from "../utils/process.js";

export interface GitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  signal?: AbortSignal;
  allowExitCodes?: readonly number[];
  maxOutputBytes?: number;
}

export function runGit(args: readonly string[], options: GitOptions = {}): Promise<ProcessResult> {
  return runProcess("git", args, options);
}

export function normalizeGitPath(path: string): string {
  return path.replaceAll("\\", "/");
}
