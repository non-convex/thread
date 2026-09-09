import { open } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../core/tools/path-safety.js";

export const PROJECT_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

/** The coding app loads one project-root document at startup, without walking other directories. */
export async function loadProjectInstructions(rootPath: string): Promise<string> {
  const source = path.join(rootPath, "AGENTS.md");
  try {
    const target = await resolveWorkspacePath(rootPath, "AGENTS.md");
    const file = await open(target, "r");
    try {
      if (!(await file.stat()).isFile()) throw new Error("AGENTS.md must be a regular file");
      const buffer = Buffer.alloc(PROJECT_INSTRUCTIONS_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > PROJECT_INSTRUCTIONS_MAX_BYTES) {
        throw new Error(`AGENTS.md exceeds ${PROJECT_INSTRUCTIONS_MAX_BYTES} bytes; keep project instructions short and link to detailed docs`);
      }
      const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      if (!content.trim()) return "";
      return `# Project instructions\n\nSource: ${source}\nRelative references resolve from ${rootPath}.\n\n${content}`;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new Error(`Cannot load project instructions from ${source}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
