import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function embeddingWorkerArgs(): string[] {
  const compiled = new URL("./embedding-worker.js", import.meta.url);
  return [fileURLToPath(existsSync(compiled) ? compiled : new URL("./embedding-worker.ts", import.meta.url))];
}
