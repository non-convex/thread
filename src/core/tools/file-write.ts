import type { Stats } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { atomicFile } from "../utils/atomic-file.js";
import type { FileContents, SaveBeforeWrite } from "../file-history/service.js";
import type { GlobalMemoryCommit } from "../global-memory.js";
import { assertFileWriteScope, samePath } from "./path-safety.js";
import { resolveToolPath } from "./execution.js";
import type { ToolContext } from "./types.js";
import { fileContentVersion, fileStatVersion, type FileObservation } from "./file-read-state.js";

/** Shared write boundary for built-in edit/write, including worker invocations. */
export async function updateFile(
  context: ToolContext,
  inputPath: string,
  transform: (before: FileContents | undefined) => Buffer,
  options: { requireRead?: boolean } = {},
): Promise<{ existed: boolean; bytes: number; fileObservation?: FileObservation }> {
  const resolveTarget = async () => {
    const target = await resolveToolPath(context, inputPath, true);
    if (context.writeScope) await assertFileWriteScope(context.rootPath, target, context.writeScope);
    return target;
  };
  const target = await resolveTarget();
  const operation = async (save: SaveBeforeWrite, commit?: GlobalMemoryCommit) => {
    context.signal.throwIfAborted();
    if (!samePath(await resolveTarget(), target)) throw new Error(`File target changed while waiting to write: ${inputPath}`);
    let before: FileContents | undefined;
    let beforeInfo: Stats | undefined;
    try {
      beforeInfo = await lstat(target);
      if (!beforeInfo.isFile() || beforeInfo.isSymbolicLink()) throw new Error(`Not a file: ${inputPath}`);
      before = { content: await readFile(target, { signal: context.signal }), mode: beforeInfo.mode & 0o777 };
      if (fileStatVersion(await lstat(target)) !== fileStatVersion(beforeInfo)) {
        throw new Error(`File changed while preparing the write: ${inputPath}. Read it again and regenerate the change.`);
      }
    } catch (error) {
      if (beforeInfo || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (options.requireRead && before && beforeInfo) {
      if (!context.fileReads) throw new Error(`Read ${inputPath} in an earlier model step before overwriting it with write.`);
      context.fileReads.assertCurrent(target, beforeInfo, before.content);
    }
    // An exact edit may use an unseen file. Only carry its version forward when
    // the model already knew the unchanged before-image; editing is not a read.
    const canRemember = !before || options.requireRead === true ||
      (beforeInfo !== undefined && context.fileReads?.matches(target, beforeInfo, before.content) === true);
    const content = transform(before);
    if (!before?.content.equals(content)) {
      await save(before);
      const beforeCommit = async () => {
        context.signal.throwIfAborted();
        if (!samePath(await resolveTarget(), target)) throw new Error(`File target changed while preparing to write: ${inputPath}`);
        const current = await lstat(target).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return undefined;
        });
        if (beforeInfo ? !current || fileStatVersion(current) !== fileStatVersion(beforeInfo) : current !== undefined) {
          throw new Error(`File changed before the write: ${inputPath}. Read it again and regenerate the change.`);
        }
      };
      await beforeCommit();
      if (commit) await commit(before, content, beforeCommit);
      else await atomicFile(target, content, {
        ...(before ? { mode: before.mode } : {}),
        overwrite: before !== undefined,
        signal: context.signal,
        beforeCommit,
      });
    }
    if (!canRemember) return { existed: before !== undefined, bytes: content.length };
    // Use the bytes we wrote, not a later stat that could describe another editor's write.
    const fileObservation = { path: target, version: fileContentVersion(content) };
    context.fileReads?.remember(fileObservation);
    return { existed: before !== undefined, bytes: content.length, fileObservation };
  };
  const write = (commit?: GlobalMemoryCommit) => context.fileHistory
    ? context.fileHistory.track(target, (save) => operation(save, commit))
    : operation(async () => undefined, commit);
  return context.globalMemory ? context.globalMemory.write(target, context, write) : write();
}
