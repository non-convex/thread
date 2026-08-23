import { createHash, randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function stableId(prefix: string, value: string, length = 20): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, length);
  return `${prefix}_${digest}`;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
