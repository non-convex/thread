import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import solidPlugin from "@opentui/solid/bun-plugin";

const root = resolve(import.meta.dir, "..");
const outdir = resolve(root, "dist");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

async function build(entrypoint: string, naming: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [resolve(root, entrypoint)],
    outdir,
    naming,
    target: "bun",
    format: "esm",
    packages: "external",
    sourcemap: "external",
    plugins: [solidPlugin],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Failed to build ${entrypoint}`);
  }
}

await build("src/cli/main.ts", "thread.js");
await build("src/index.ts", "index.js");
await build("src/session-recall/embedding-worker.ts", "embedding-worker.js");
