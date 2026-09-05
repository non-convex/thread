import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getThreadHome } from "../config/thread-config.js";
import { atomicJson } from "../utils/atomic-json.js";

export const MODEL_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
export const MODEL_REPO = "Xenova/multilingual-e5-small";
export const MODEL_IDENTITY = `${MODEL_REPO}@${MODEL_REVISION}:q8:mean:normalized:query/passage:v1`;
export const EMBEDDING_DIMENSION = 384;
export const MODEL_FILES = [
  { name: "onnx/model_quantized.onnx", size: 118308185, sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193" },
  { name: "tokenizer.json", size: 17082730, sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39" },
  { name: "tokenizer_config.json", size: 443, sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b" },
] as const;

async function validFile(file: string, expected: typeof MODEL_FILES[number], signal: AbortSignal): Promise<boolean> {
  try {
    if ((await stat(file)).size !== expected.size) return false;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
    return hash.digest("hex") === expected.sha256;
  } catch (error) {
    signal.throwIfAborted();
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function download(file: typeof MODEL_FILES[number], directory: string, signal: AbortSignal): Promise<void> {
  const target = path.join(directory, file.name);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const endpoint = (process.env.HF_ENDPOINT ?? "https://huggingface.co").replace(/\/$/, "");
  const response = await fetch(`${endpoint}/${MODEL_REPO}/resolve/${MODEL_REVISION}/${file.name}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
  });
  if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status}): ${file.name}`);
  const handle = await open(temporary, "wx");
  try {
    const hash = createHash("sha256");
    let bytes = 0;
    const writeChunk = async (chunk: Uint8Array) => {
      signal.throwIfAborted();
      bytes += chunk.byteLength;
      if (bytes > file.size) throw new Error(`Unexpected model file size: ${file.name}`);
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.length) offset += (await handle.write(chunk, offset)).bytesWritten;
    };
    if (file.size < 64 * 1024) {
      // Bun 1.3.14's reader can throw after a small HTTP response has already
      // completed. Buffer the tiny metadata file; stream the large model assets.
      await writeChunk(new Uint8Array(await response.arrayBuffer()));
    } else {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          await writeChunk(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    if (bytes !== file.size || hash.digest("hex") !== file.sha256) {
      throw new Error(`Model integrity check failed: ${file.name}`);
    }
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

async function completeModel(directory: string, signal: AbortSignal): Promise<boolean> {
  try {
    const completion = JSON.parse(await readFile(path.join(directory, "complete.json"), "utf8")) as { identity?: string } | null;
    if (completion?.identity !== MODEL_IDENTITY) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
  for (const file of MODEL_FILES) if (!await validFile(path.join(directory, file.name), file, signal)) return false;
  return true;
}

/** Shared weights, never shared project data. A dead owner's lock can be reclaimed. */
export async function prepareModel(signal: AbortSignal, home = getThreadHome()): Promise<string> {
  signal.throwIfAborted();
  const directory = path.join(home, "models", "multilingual-e5-small", MODEL_REVISION);
  if (await completeModel(directory, signal)) return directory;
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, "download.lock");
  let lock: Awaited<ReturnType<typeof open>>;
  while (true) {
    signal.throwIfAborted();
    try {
      lock = await open(lockPath, "wx");
      await lock.writeFile(String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = Number(await readFile(lockPath, "utf8"));
        if (Number.isSafeInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (failure) {
            if ((failure as NodeJS.ErrnoException).code === "ESRCH") await rm(lockPath, { force: true });
          }
        } else if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) {
          await rm(lockPath, { force: true });
        }
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
      }
      await delay(100, undefined, { signal });
    }
  }
  try {
    for (const file of MODEL_FILES) {
      signal.throwIfAborted();
      try {
        if (!await validFile(path.join(directory, file.name), file, signal)) await download(file, directory, signal);
      } catch (error) {
        signal.throwIfAborted();
        throw new Error(`Preparing ${file.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    await atomicJson(path.join(directory, "complete.json"), { identity: MODEL_IDENTITY });
    return directory;
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
