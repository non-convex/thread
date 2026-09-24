import {
  createHostClipboard,
  createRendererClipboardAdapter,
  type ClipboardReadResult,
  type ClipboardService,
  type HostClipboardService,
  type RendererClipboardBoundary,
} from "@opentui/core";
import {
  composerImageFromBytes,
  type ComposerImage,
} from "../images.js";
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from "../../core/images/prepare.js";

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

export type CopyText = (text: string) => Promise<"written" | "attempted" | "cancelled" | "failed">;

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

export async function writeClipboardText(
  renderer: RendererClipboardBoundary,
  clipboard: ClipboardService | undefined,
  text: string,
  signal: AbortSignal,
): Promise<"written" | "attempted" | "cancelled"> {
  if (signal.aborted) return "cancelled";
  const result = clipboard
    ? await clipboard.writeText(text, { destination: "best-available", signal })
    : { host: { status: "not-attempted" as const }, terminal: createRendererClipboardAdapter(renderer).writeText(text, "clipboard") };
  if (signal.aborted || result.host.status === "cancelled") return "cancelled";
  if (result.host.status === "written") return "written";
  if (result.terminal.status === "attempted") return "attempted";
  if (result.host.status === "failed") throw result.host.error;
  if (result.host.status === "timed-out") throw new Error("Writing to the clipboard timed out");
  throw new Error("Clipboard is unavailable. Use your terminal's native text selection to copy.");
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
