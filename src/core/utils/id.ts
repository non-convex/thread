import { createHash, randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function stableId(prefix: string, value: string, length = 20): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, length);
  return `${prefix}_${digest}`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const HASH_CHUNK_BYTES = 1024 * 1024;

/** Hash large buffers without monopolizing the event loop for one whole file. */
export async function sha256Cooperative(value: Buffer): Promise<string> {
  const hash = createHash("sha256");
  let lastYield = performance.now();
  for (let offset = 0; offset < value.length; offset += HASH_CHUNK_BYTES) {
    hash.update(value.subarray(offset, Math.min(value.length, offset + HASH_CHUNK_BYTES)));
    if (performance.now() - lastYield >= 8) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      lastYield = performance.now();
    }
  }
  return hash.digest("hex");
}
