import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import solidPlugin from "@opentui/solid/bun-plugin";

const root = resolve(import.meta.dir, "..");
const outdir = resolve(root, "dist");

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

async function build(entrypoint: string, naming: string, tui = false): Promise<void> {
  const result = await Bun.build({
    entrypoints: [resolve(root, entrypoint)],
    outdir,
    naming,
    target: "bun",
    format: "esm",
    packages: "external",
    sourcemap: "external",
    plugins: tui ? [solidPlugin] : [],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`Failed to build ${entrypoint}`);
  }
}

await build("src/cli/main.ts", "thread.js", true);
// Public entries must share constructors and module state. Separate bundles
// would break instanceof checks between errors produced by different entries.
const library = await Bun.build({
  entrypoints: ["src/index.ts", "src/runtime.ts", "src/tui.ts"].map((entry) => resolve(root, entry)),
  outdir,
  naming: { entry: "[name].js", chunk: "chunk-[hash].js", asset: "[name]-[hash].[ext]" },
  splitting: true,
  target: "bun",
  format: "esm",
  packages: "external",
  sourcemap: "external",
  plugins: [solidPlugin],
});
if (!library.success) {
  for (const log of library.logs) console.error(log);
  throw new Error("Failed to build Thread library entrypoints");
}
// Keep shared chunks beside this worker: worker-path resolves it relative to
// import.meta.url, whether the caller lives in an entry or a shared chunk.
await build("src/session-recall/embedding-worker.ts", "embedding-worker.js");
