import { mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tryLock } from "fs-native-extensions";

/** OS-owned locks release on process exit. Never unlink a locked file's identity. */
export async function lockFile(file: string, wait = false, signal?: AbortSignal): Promise<FileHandle> {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "a+", 0o600);
  try {
    for (;;) {
      signal?.throwIfAborted();
      if (tryLock(handle.fd)) return handle;
      if (!wait) throw new Error(`File is already locked: ${file}`);
      await delay(50, undefined, { signal });
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
}
