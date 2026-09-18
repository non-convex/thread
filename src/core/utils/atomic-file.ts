import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

/** Replace a file without exposing a truncated or partially written version. */
export async function atomicFile(file: string, content: string | Uint8Array, options: { mode?: number; signal?: AbortSignal } = {}): Promise<void> {
  options.signal?.throwIfAborted();
  await mkdir(path.dirname(file), { recursive: true });
  options.signal?.throwIfAborted();
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", options.mode);
  try {
    await handle.writeFile(content, { signal: options.signal });
    await handle.sync();
    await handle.close();
    options.signal?.throwIfAborted();
    await rename(temporary, file);
    if (options.mode !== undefined) await chmod(file, options.mode).catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}
