import { ProcessError, runProcess } from "./process.js";

const GIT_TIMEOUT_MS = 2_000;

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0" };
}

async function git(args: readonly string[], cwd: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const result = await runProcess("git", args, {
      cwd,
      env: gitEnv(),
      signal,
      allowExitCodes: [0, 128],
      maxOutputBytes: 4_096,
    });
    if (result.code !== 0) return undefined;
    const value = result.stdout.toString("utf8").trim();
    return value || undefined;
  } catch (error) {
    if (error instanceof ProcessError) return undefined;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as Error).name === "AbortError" || (error as Error).name === "TimeoutError") return undefined;
    return undefined;
  }
}

/** Current branch, or a short SHA when detached. Undefined when the path is not a git work tree. */
export async function gitBranchName(rootPath: string): Promise<string | undefined> {
  const signal = AbortSignal.timeout(GIT_TIMEOUT_MS);
  const branch = await git(["symbolic-ref", "--short", "HEAD"], rootPath, signal);
  if (branch) return branch;
  return await git(["rev-parse", "--short", "HEAD"], rootPath, signal);
}
