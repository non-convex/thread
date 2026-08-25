import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { SessionSummary } from "../domain.js";
import { stableId } from "../utils/id.js";

interface CatalogSession {
  id: string;
  createdAt: number;
  lastActivatedAt: number;
}

interface CatalogFile {
  version: 1;
  rootPath: string;
  activeSessionId: string;
  sessions: CatalogSession[];
}

export interface ProjectSessionCatalogOptions {
  rootPath: string;
  sidecarRoot: string;
}

function normalizedRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isCatalogFile(value: unknown): value is CatalogFile {
  if (!value || typeof value !== "object") return false;
  const catalog = value as Partial<CatalogFile>;
  return catalog.version === 1 &&
    typeof catalog.rootPath === "string" &&
    typeof catalog.activeSessionId === "string" && /^session_[A-Za-z0-9]+$/.test(catalog.activeSessionId) &&
    Array.isArray(catalog.sessions) &&
    catalog.sessions.every((session) =>
      session && typeof session === "object" &&
      typeof session.id === "string" && /^session_[A-Za-z0-9]+$/.test(session.id) &&
      typeof session.createdAt === "number" && Number.isFinite(session.createdAt) &&
      typeof session.lastActivatedAt === "number" && Number.isFinite(session.lastActivatedAt)
    );
}

export class ProjectSessionCatalog {
  readonly projectId: string;
  readonly catalogPath: string;
  readonly lockPath: string;
  readonly rootPath: string;
  private lockHandle: FileHandle | undefined;
  private catalog: CatalogFile;

  private constructor(options: ProjectSessionCatalogOptions) {
    this.rootPath = path.resolve(options.rootPath);
    this.projectId = stableId("project", normalizedRoot(options.rootPath));
    this.catalogPath = path.join(options.sidecarRoot, "projects", `${this.projectId}.json`);
    this.lockPath = path.join(options.sidecarRoot, "locks", `${this.projectId}.lock`);
    this.catalog = {
      version: 1,
      rootPath: this.rootPath,
      activeSessionId: stableId("session", normalizedRoot(options.rootPath)),
      sessions: [],
    };
  }

  static async open(options: ProjectSessionCatalogOptions): Promise<ProjectSessionCatalog> {
    const result = new ProjectSessionCatalog(options);
    await mkdir(path.dirname(result.catalogPath), { recursive: true });
    await mkdir(path.dirname(result.lockPath), { recursive: true });
    await result.acquireLock();
    try {
      await result.load();
      return result;
    } catch (error) {
      await result.close();
      throw error;
    }
  }

  get activeSessionId(): string {
    return this.catalog.activeSessionId;
  }

  list(): SessionSummary[] {
    return this.catalog.sessions
      .map((session) => ({ ...session, current: session.id === this.catalog.activeSessionId }))
      .sort((left, right) =>
        Number(right.current) - Number(left.current) ||
        right.lastActivatedAt - left.lastActivatedAt ||
        right.createdAt - left.createdAt ||
        left.id.localeCompare(right.id)
      );
  }

  resolve(idOrPrefix: string): string {
    const exact = this.catalog.sessions.find((session) => session.id === idOrPrefix);
    if (exact) return exact.id;
    const matches = this.catalog.sessions.filter((session) =>
      session.id.startsWith(idOrPrefix),
    );
    if (matches.length === 0) throw new Error(`Unknown project session: ${idOrPrefix}`);
    if (matches.length > 1) throw new Error(`Project session prefix is ambiguous: ${idOrPrefix}`);
    return matches[0]!.id;
  }

  async activate(id: string, createdAt: number, activatedAt = Date.now()): Promise<void> {
    const next = structuredClone(this.catalog);
    const existing = next.sessions.find((session) => session.id === id);
    if (existing) {
      existing.createdAt = Math.min(existing.createdAt, createdAt);
      existing.lastActivatedAt = activatedAt;
    } else {
      next.sessions.push({ id, createdAt, lastActivatedAt: activatedAt });
    }
    next.activeSessionId = id;
    await this.write(next);
    this.catalog = next;
  }

  async remove(id: string): Promise<void> {
    const next = structuredClone(this.catalog);
    next.sessions = next.sessions.filter((session) => session.id !== id);
    if (next.sessions.length === 0) {
      await rm(this.catalogPath, { force: true });
      this.catalog = next;
      return;
    }
    if (next.activeSessionId === id) {
      next.sessions.sort((left, right) =>
        right.lastActivatedAt - left.lastActivatedAt || right.createdAt - left.createdAt,
      );
      next.activeSessionId = next.sessions[0]!.id;
    }
    await this.write(next);
    this.catalog = next;
  }

  async fsck(sessionIds: ReadonlySet<string>): Promise<string[]> {
    const issues: string[] = [];
    if (!this.catalog.sessions.some((session) => session.id === this.catalog.activeSessionId)) {
      issues.push(`session catalog active id ${this.catalog.activeSessionId} is not registered`);
    }
    for (const session of this.catalog.sessions) {
      if (!sessionIds.has(session.id)) issues.push(`session catalog references missing session ${session.id}`);
    }
    return issues;
  }

  async close(): Promise<void> {
    await this.lockHandle?.close().catch(() => undefined);
    this.lockHandle = undefined;
    await rm(this.lockPath, { force: true }).catch(() => undefined);
  }

  private async acquireLock(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.lockHandle = await open(this.lockPath, "wx", 0o600);
        await this.lockHandle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
        await this.lockHandle.sync();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const content = await readFile(this.lockPath, "utf8").catch(() => "");
        const pid = Number.parseInt(content.split(/\r?\n/, 1)[0] ?? "", 10);
        if (Number.isFinite(pid) && isProcessAlive(pid)) {
          throw new Error(`Project is already open by process ${pid}`);
        }
        await rm(this.lockPath, { force: true });
      }
    }
    throw new Error(`Could not acquire project lock: ${this.lockPath}`);
  }

  private async load(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.catalogPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error(`Invalid project session catalog: ${(error as Error).message}`);
    }
    if (!isCatalogFile(parsed)) throw new Error("Invalid project session catalog shape");
    if (normalizedRoot(parsed.rootPath) !== normalizedRoot(this.rootPath)) {
      throw new Error(`Project session catalog root mismatch: ${parsed.rootPath}`);
    }
    const ids = new Set<string>();
    for (const session of parsed.sessions) {
      if (ids.has(session.id)) throw new Error(`Duplicate project session in catalog: ${session.id}`);
      ids.add(session.id);
    }
    if (parsed.sessions.length > 0 && !ids.has(parsed.activeSessionId)) {
      throw new Error(`Project session catalog has unknown active session: ${parsed.activeSessionId}`);
    }
    this.catalog = parsed;
  }

  private async write(catalog: CatalogFile): Promise<void> {
    const temporary = `${this.catalogPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      // Windows rejects FlushFileBuffers for read-only handles; O_RDWR keeps
      // the atomic catalog update durable on every supported platform.
      const handle = await open(temporary, constants.O_RDWR);
      await handle.sync().finally(() => handle.close());
      await rename(temporary, this.catalogPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
