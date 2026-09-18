import { atomicFile } from "./atomic-file.js";

export async function atomicJson(file: string, value: unknown, options: { mode?: number; pretty?: boolean } = {}): Promise<void> {
  await atomicFile(file, options.pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value), options);
}
