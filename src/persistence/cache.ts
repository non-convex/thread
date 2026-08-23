import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "../utils/id.js";

export class DerivedCache {
  constructor(private readonly rootPath: string) {}

  private pathFor(namespace: string, key: string, extension = "json"): string {
    if (!/^[A-Za-z0-9._-]+$/.test(namespace) || !/^[A-Za-z0-9._-]+$/.test(key)) {
      throw new Error("Invalid cache namespace or key");
    }
    return path.join(this.rootPath, namespace, `${key}.${extension}`);
  }

  async readJson<T>(namespace: string, key: string): Promise<T | undefined> {
    const target = this.pathFor(namespace, key);
    try {
      return JSON.parse(await readFile(target, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) {
        await rm(target, { force: true });
        return undefined;
      }
      throw error;
    }
  }

  async writeJson(namespace: string, key: string, value: unknown): Promise<void> {
    const target = this.pathFor(namespace, key);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${createId("tmp")}`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async readText(namespace: string, key: string): Promise<string | undefined> {
    try {
      return await readFile(this.pathFor(namespace, key, "txt"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async writeText(namespace: string, key: string, value: string): Promise<void> {
    const target = this.pathFor(namespace, key, "txt");
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${createId("tmp")}`;
    try {
      await writeFile(temporary, value, "utf8");
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
