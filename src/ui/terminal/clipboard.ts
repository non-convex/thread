import {
  createHostClipboard,
  type ClipboardReadResult,
  type HostClipboardService,
} from "@opentui/core";
import {
  composerImageFromBytes,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  type ComposerImage,
} from "../images.js";

const HOST_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "text/uri-list",
  "text/plain",
] as const;

export type HostClipboardContent =
  | { type: "image"; image: ComposerImage }
  | { type: "text"; text: string };

export function tryCreateHostClipboard(): HostClipboardService | undefined {
  try {
    return createHostClipboard({
      timeoutMs: 1_000,
      maxReadBytes: MAX_IMAGE_BYTES,
      maxImagePixels: MAX_IMAGE_PIXELS,
    });
  } catch {
    return undefined;
  }
}

export async function readHostClipboard(host: HostClipboardService): Promise<HostClipboardContent | undefined> {
  const result = await host.read({ preferredTypes: HOST_TYPES });
  assertClipboardRead(result);
  if (result.status !== "read") return undefined;
  if (result.representation.mimeType.startsWith("image/")) {
    return { type: "image", image: await composerImageFromBytes(result.representation.bytes) };
  }
  return {
    type: "text",
    text: new TextDecoder("utf-8", { fatal: false }).decode(result.representation.bytes),
  };
}

function assertClipboardRead(result: ClipboardReadResult): void {
  if (result.status === "limit-exceeded") throw new Error("Clipboard content is larger than 8 MB");
  if (result.status === "timed-out") throw new Error("Reading the clipboard timed out");
  if (result.status === "failed") throw result.error;
}
