import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ToolResultMetadata } from "./types.js";

/** A file version associated with a successful, model-visible tool result. */
export interface FileObservation {
  path: string;
  version: string;
}

export function fileContentVersion(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** Large range reads do not scan the rest of the file just to compute a hash. */
export function fileStatVersion(info: Stats): string {
  return `stat:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

function pathKey(target: string): string {
  const normalized = path.normalize(target);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Rebuilt from the actual request, so discarded reads and compacted-away results grant no access. */
export class FileReadState {
  private readonly versions = new Map<string, string>();

  observeModelContext(messages: readonly Message[]): void {
    this.versions.clear();
    for (const message of messages) {
      if (message.role !== "toolResult" || message.isError) continue;
      const observation = (message.details as ToolResultMetadata | undefined)?.fileObservation;
      if (observation && typeof observation.path === "string" && typeof observation.version === "string") {
        this.remember(observation);
      }
    }
  }

  matches(target: string, info: Stats, content: Buffer): boolean {
    const version = this.versions.get(pathKey(target));
    if (!version) return false;
    return version === (version.startsWith("sha256:") ? fileContentVersion(content) : fileStatVersion(info));
  }

  assertCurrent(target: string, info: Stats, content: Buffer): void {
    if (!this.versions.has(pathKey(target))) {
      throw new Error(`Read ${target} in an earlier model step before overwriting it with write. A summary or a read in the same tool batch is not sufficient.`);
    }
    if (!this.matches(target, info, content)) {
      throw new Error(`File changed since it was read: ${target}. Re-read it in a separate model step and regenerate the write.`);
    }
  }

  remember(observation: FileObservation): void {
    this.versions.set(pathKey(observation.path), observation.version);
  }
}
