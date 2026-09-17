import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

export async function atomicJson(file: string, value: unknown, options: { mode?: number; pretty?: boolean } = {}): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", options.mode);
  try {
    await handle.writeFile(options.pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value));
    await handle.sync();
    await handle.close();
    await rename(temporary, file);
    if (options.mode !== undefined) await chmod(file, options.mode).catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}
