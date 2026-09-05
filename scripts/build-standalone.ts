import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import solidPlugin from "@opentui/solid/bun-plugin";
import { recallNativePlugin } from "./recall-bundle.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const target = option("--target") ?? `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const defaultName = process.platform === "win32" ? "thread.exe" : "thread";
const outfile = resolve(option("--outfile") ?? `release/${defaultName}`);
await mkdir(dirname(outfile), { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "../src/cli/main.ts")],
  target: "bun",
  plugins: [solidPlugin, recallNativePlugin(target)],
  minify: true,
  compile: {
    target: target as Bun.Build.CompileTarget,
    outfile,
    // A CLI must not inherit an unrelated project's Bun runtime hooks.
    // Keep .env loading for provider credentials, but make bunfig build-time only.
    autoloadBunfig: false,
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error(`Failed to compile Thread for ${target}`);
}

console.log(outfile);
