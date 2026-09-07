import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { Project } from "../project/model.js";
import { sha256Cooperative } from "../utils/id.js";

/** Immutable, content-addressed copies of files before an internal edit. */
export class FileHistoryStore {
  readonly blobsPath: string;

  constructor(project: Project) {
    this.blobsPath = path.join(project.statePath, "file-history", "blobs");
  }

  blobPath(blobId: string): string {
    if (!/^[0-9a-f]{64}$/.test(blobId)) throw new Error(`Invalid file history blob id: ${blobId}`);
    return path.join(this.blobsPath, blobId.slice(0, 2), blobId.slice(2));
  }

  async put(content: Buffer): Promise<string> {
    const blobId = await sha256Cooperative(content);
    const target = this.blobPath(blobId);
    try {
      await this.read(blobId);
      return blobId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${crypto.randomUUID()}`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, target);
      } catch (error) {
        if (!["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        await this.read(blobId);
      }
      await this.read(blobId);
      return blobId;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async read(blobId: string): Promise<Buffer> {
    const content = await readFile(this.blobPath(blobId));
    if (await sha256Cooperative(content) !== blobId) throw new Error(`File history blob is corrupt: ${blobId}`);
    return content;
  }

  async garbageCollect(referenced: ReadonlySet<string>): Promise<{ blobsRemoved: number }> {
    let prefixes;
    try {
      prefixes = await readdir(this.blobsPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { blobsRemoved: 0 };
      throw error;
    }
    let blobsRemoved = 0;
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name)) continue;
      const directory = path.join(this.blobsPath, prefix.name);
      for (const blob of await readdir(directory, { withFileTypes: true })) {
        const id = `${prefix.name}${blob.name}`;
        if (!blob.isFile() || !/^[0-9a-f]{64}$/.test(id) || referenced.has(id)) continue;
        await rm(this.blobPath(id));
        blobsRemoved++;
      }
    }
    return { blobsRemoved };
  }
}
