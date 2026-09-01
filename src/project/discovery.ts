import { stat } from "node:fs/promises";
import path from "node:path";

export async function discoverProjectRoot(input: string): Promise<string> {
  const rootPath = path.resolve(input);
  let info;
  try {
    info = await stat(rootPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Project root does not exist: ${rootPath}`);
    }
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`Project root is not a directory: ${rootPath}`);
  return rootPath;
}
