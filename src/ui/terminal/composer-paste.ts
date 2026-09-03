import type { HostClipboardService, PasteEvent } from "@opentui/core";
import { decodePasteBytes } from "@opentui/core";
import {
  candidateImagePaths,
  clipboardImagePipeline,
  composerImageFromBytes,
  composerImageFromPipeline,
  composerImagesFromPaths,
  MAX_COMPOSER_IMAGES,
  type ComposerImage,
} from "../images.js";
import { readHostClipboard } from "./clipboard.js";

export interface ComposerPasteHost {
  rootPath: string;
  attachments(): readonly ComposerImage[];
  setAttachments(images: ComposerImage[]): void;
  insertText(text: string): void;
  note(text: string, level?: "info" | "error"): void;
  hostClipboard?: HostClipboardService;
}

/**
 * Starts a native macOS/Windows image paste without reading the clipboard twice.
 * Returning undefined is synchronous, so the key handler can leave text paste alone.
 */
export function beginClipboardImagePaste(host: ComposerPasteHost): Promise<void> | undefined {
  let pipeline: ReturnType<typeof clipboardImagePipeline>;
  try {
    pipeline = clipboardImagePipeline();
  } catch (error) {
    host.note(error instanceof Error ? error.message : String(error), "error");
    return Promise.resolve();
  }
  if (!pipeline) return undefined;
  return composerImageFromPipeline(pipeline)
    .then((image) => { addImages(host, [image]); })
    .catch((error) => {
      host.note(error instanceof Error ? error.message : String(error), "error");
    });
}

export async function pasteHostClipboard(host: ComposerPasteHost): Promise<void> {
  if (!host.hostClipboard) return;
  try {
    const content = await readHostClipboard(host.hostClipboard);
    if (!content) return;
    if (content.type === "image") {
      addImages(host, [content.image]);
      return;
    }
    if (await pasteImagePaths(host, content.text)) return;
    host.insertText(content.text);
  } catch (error) {
    host.note(error instanceof Error ? error.message : String(error), "error");
  }
}

/** Image-only variant used by Alt+V, which must never insert text. */
export async function pasteHostClipboardImage(host: ComposerPasteHost): Promise<boolean> {
  if (!host.hostClipboard) return false;
  try {
    const content = await readHostClipboard(host.hostClipboard);
    if (content?.type !== "image") return false;
    addImages(host, [content.image]);
    return true;
  } catch (error) {
    host.note(error instanceof Error ? error.message : String(error), "error");
    return false;
  }
}

export async function handleComposerPaste(host: ComposerPasteHost, event: PasteEvent): Promise<boolean> {
  const mime = event.metadata?.mimeType;
  if (mime?.startsWith("image/") || event.metadata?.kind === "binary") {
    event.preventDefault();
    try {
      addImages(host, [await composerImageFromBytes(event.bytes)]);
    } catch (error) {
      host.note(error instanceof Error ? error.message : String(error), "error");
    }
    return true;
  }
  const text = decodePasteBytes(event.bytes);
  const paths = candidateImagePaths(text);
  if (!paths) return false;
  event.preventDefault();
  if (await pasteImagePaths(host, text)) return true;
  host.insertText(text);
  return true;
}

async function pasteImagePaths(host: ComposerPasteHost, text: string): Promise<boolean> {
  const paths = candidateImagePaths(text);
  if (!paths) return false;
  try {
    const images = await composerImagesFromPaths(paths, host.rootPath);
    if (!images) return false;
    addImages(host, images);
    return true;
  } catch (error) {
    host.note(error instanceof Error ? error.message : String(error), "error");
    return true;
  }
}

function addImages(host: ComposerPasteHost, images: readonly ComposerImage[]): void {
  const current = host.attachments();
  if (current.length + images.length > MAX_COMPOSER_IMAGES) {
    host.note(`You can attach at most ${MAX_COMPOSER_IMAGES} images.`, "error");
    return;
  }
  host.setAttachments([...current, ...images]);
}
