import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getThreadHome } from "../config/thread-config.js";

/** Bun's virtual files cannot be passed to the platform dynamic-library loader. */
export function materializeNativeAssets(version: string, assets: { name: string; source: string; sha256: string }[]): string {
  const directory = path.join(getThreadHome(), "native", version);
  for (const asset of assets) {
    const target = path.join(directory, asset.name);
    try {
      if (createHash("sha256").update(readFileSync(target)).digest("hex") === asset.sha256) continue;
    } catch { /* Missing or interrupted extraction is repaired from the executable. */ }
    mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, readFileSync(asset.source));
      try { renameSync(temporary, target); }
      catch (error) {
        // Another process may have installed and loaded the same DLL in the meantime.
        if (createHash("sha256").update(readFileSync(target)).digest("hex") !== asset.sha256) throw error;
      }
    } finally { rmSync(temporary, { force: true }); }
  }
  return directory;
}
