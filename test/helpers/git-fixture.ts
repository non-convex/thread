import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runGit } from "../../src/workspace/git.js";

export async function initRepository(rootPath: string): Promise<void> {
  await mkdir(rootPath, { recursive: true });
  await runGit(["init", "--initial-branch=main", rootPath]);
  await runGit(["-C", rootPath, "config", "user.name", "thread test"]);
  await runGit(["-C", rootPath, "config", "user.email", "thread@test.local"]);
  await runGit(["-C", rootPath, "config", "core.autocrlf", "false"]);
}

export async function commitAll(rootPath: string, message: string): Promise<string> {
  await runGit(["-C", rootPath, "add", "-A"]);
  await runGit(["-C", rootPath, "commit", "-m", message]);
  const head = await runGit(["-C", rootPath, "rev-parse", "HEAD"]);
  return head.stdout.toString("utf8").trim();
}

export async function addGitlink(rootPath: string, relativePath: string): Promise<string> {
  const nested = path.join(rootPath, relativePath);
  await initRepository(nested);
  await writeFile(path.join(nested, "nested.txt"), "nested\n");
  const oid = await commitAll(nested, "nested");
  await runGit(["-C", rootPath, "update-index", "--add", "--cacheinfo", `160000,${oid},${relativePath}`]);
  return oid;
}

/**
 * Removes a fixture directory, tolerating Windows EBUSY. Sidecar git processes
 * may still hold a handle for a moment after a session closes, and `rm` fails
 * outright instead of waiting; retrying briefly avoids a spurious test error
 * without hiding a genuine failure.
 */
export async function removeFixture(fixturePath: string, attempts = 5): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await rm(fixturePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === attempts || (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM")) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}
