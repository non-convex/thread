import path from "node:path";
import { runGit } from "./git.js";

export interface GitWorkspace {
  rootPath: string;
  gitDir: string;
  gitCommonDir: string;
  sidecarRoot: string;
}

async function revParse(cwd: string, argument: string): Promise<string> {
  const result = await runGit(["-C", cwd, "rev-parse", argument]);
  const value = result.stdout.toString("utf8").trim();
  return path.resolve(cwd, value);
}

export async function discoverGitWorkspace(cwd: string): Promise<GitWorkspace> {
  const rootResult = await runGit(["-C", cwd, "rev-parse", "--show-toplevel"]);
  const rootPath = path.resolve(rootResult.stdout.toString("utf8").trim());
  const gitDir = await revParse(rootPath, "--git-dir");
  const gitCommonDir = await revParse(rootPath, "--git-common-dir");
  return {
    rootPath,
    gitDir,
    gitCommonDir,
    sidecarRoot: path.join(gitCommonDir, "thread"),
  };
}
