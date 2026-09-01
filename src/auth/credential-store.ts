import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { getThreadHome } from "../config/thread-config.js";
import { createId } from "../utils/id.js";

export const DEFAULT_AUTH_FILE = "auth.json";
const AUTH_FILE_FORMAT = 1;
const STALE_LOCK_MS = 10 * 60 * 1_000;

interface CredentialDocument {
  format: typeof AUTH_FILE_FORMAT;
  credentials: Record<string, Credential>;
}

function nodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function cloneCredential(credential: Credential | undefined): Credential | undefined {
  return credential === undefined ? undefined : structuredClone(credential);
}

function parseCredential(value: unknown, label: string): Credential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  if (input.type === "oauth") {
    if (typeof input.access !== "string" || typeof input.refresh !== "string" ||
      typeof input.expires !== "number" || !Number.isFinite(input.expires)) {
      throw new Error(`${label} contains an invalid OAuth credential`);
    }
    return structuredClone(input) as Credential;
  }
  if (input.type === "api_key") {
    if (input.key !== undefined && typeof input.key !== "string") {
      throw new Error(`${label}.key must be a string`);
    }
    if (input.env !== undefined &&
      (typeof input.env !== "object" || input.env === null || Array.isArray(input.env))) {
      throw new Error(`${label}.env must be an object`);
    }
    return structuredClone(input) as Credential;
  }
  throw new Error(`${label}.type must be oauth or api_key`);
}

function parseDocument(source: string, filePath: string): CredentialDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Could not parse credential store ${filePath}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Credential store ${filePath} must contain an object`);
  }
  const input = parsed as Record<string, unknown>;
  if (input.format !== AUTH_FILE_FORMAT) {
    throw new Error(`Unsupported credential store format in ${filePath}`);
  }
  if (typeof input.credentials !== "object" || input.credentials === null || Array.isArray(input.credentials)) {
    throw new Error(`Credential store ${filePath} has no credential map`);
  }
  const credentials: Record<string, Credential> = {};
  for (const [providerId, credential] of Object.entries(input.credentials)) {
    credentials[providerId] = parseCredential(credential, `credentials.${providerId}`);
  }
  return { format: AUTH_FILE_FORMAT, credentials };
}

export function getAuthFilePath(): string {
  return path.join(getThreadHome(), DEFAULT_AUTH_FILE);
}

/**
 * Persistent provider credentials owned by Thread. Writes are serialized both
 * in-process and across Thread processes so a rotating OAuth refresh token is
 * never refreshed concurrently by two sessions.
 */
export class ThreadCredentialStore implements CredentialStore {
  private readonly lockPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly filePath = getAuthFilePath()) {
    this.lockPath = `${filePath}.lock`;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const document = await this.readDocument();
    options?.signal?.throwIfAborted();
    return cloneCredential(document.credentials[providerId]);
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const document = await this.readDocument();
    options?.signal?.throwIfAborted();
    return Object.entries(document.credentials)
      .map(([providerId, credential]) => ({ providerId, type: credential.type }))
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueueWrite(async () =>
      this.withFileLock(async () => {
        options?.signal?.throwIfAborted();
        const document = await this.readDocument();
        const current = cloneCredential(document.credentials[providerId]);
        const next = await fn(current);
        options?.signal?.throwIfAborted();
        if (next !== undefined) {
          document.credentials[providerId] = structuredClone(next);
          await this.writeDocument(document);
        }
        return cloneCredential(next ?? current);
      }, options?.signal)
    );
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueueWrite(async () =>
      this.withFileLock(async () => {
        options?.signal?.throwIfAborted();
        const document = await this.readDocument();
        if (!(providerId in document.credentials)) return;
        delete document.credentials[providerId];
        await this.writeDocument(document);
      }, options?.signal)
    );
  }

  private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const queued = this.writeQueue.then(task, task);
    this.writeQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async readDocument(): Promise<CredentialDocument> {
    let source: string;
    try {
      source = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (nodeError(error, "ENOENT")) return { format: AUTH_FILE_FORMAT, credentials: {} };
      throw error;
    }
    return parseDocument(source, this.filePath);
  }

  private async writeDocument(document: CredentialDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${createId("tmp")}`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600).catch(() => undefined);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async withFileLock<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const handle = await this.acquireFileLock(signal);
    try {
      return await task();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(this.lockPath, { force: true }).catch(() => undefined);
    }
  }

  private async acquireFileLock(signal?: AbortSignal): Promise<FileHandle> {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    for (;;) {
      signal?.throwIfAborted();
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, "utf8");
          return handle;
        } catch (error) {
          await handle.close().catch(() => undefined);
          await rm(this.lockPath, { force: true }).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        if (!nodeError(error, "EEXIST")) throw error;
        if (await this.lockIsStale()) {
          await rm(this.lockPath, { force: true }).catch(() => undefined);
          continue;
        }
        if (signal) await delay(50, undefined, { signal });
        else await delay(50);
      }
    }
  }

  private async lockIsStale(): Promise<boolean> {
    try {
      const details = await stat(this.lockPath);
      if (Date.now() - details.mtimeMs > STALE_LOCK_MS) return true;
      const value = JSON.parse(await readFile(this.lockPath, "utf8")) as { pid?: unknown };
      if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return true;
      try {
        process.kill(value.pid as number, 0);
        return false;
      } catch (error) {
        return nodeError(error, "ESRCH");
      }
    } catch (error) {
      return nodeError(error, "ENOENT");
    }
  }
}
