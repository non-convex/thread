import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileContents, SaveBeforeWrite } from "../file-history/service.js";
import { resolveWorkspacePath } from "./path-safety.js";
import type { ToolContext } from "./types.js";

/** Shared write boundary for built-in edit/write, including worker invocations. */
export async function updateFile(
  context: ToolContext,
  inputPath: string,
  transform: (before: FileContents | undefined) => Buffer,
): Promise<{ existed: boolean; bytes: number }> {
  const options = {
    forWrite: true,
    ...(context.writableExternalPaths ? { allowedOutsidePaths: context.writableExternalPaths } : {}),
  };
  const target = await resolveWorkspacePath(context.rootPath, inputPath, options);
  const operation = async (save: SaveBeforeWrite) => {
    context.signal.throwIfAborted();
    await resolveWorkspacePath(context.rootPath, inputPath, options);
    let before: FileContents | undefined;
    try {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Not a file: ${inputPath}`);
      before = { content: await readFile(target), mode: info.mode & 0o777 };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const content = transform(before);
    if (!before?.content.equals(content)) {
      await save(before);
      context.signal.throwIfAborted();
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    return { existed: before !== undefined, bytes: content.length };
  };
  return context.fileHistory
    ? context.fileHistory.track(target, operation)
    : operation(async () => undefined);
}
