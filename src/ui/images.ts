import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createId } from "../core/utils/id.js";
import { prepareImageBytes, prepareImagePipeline, type ImagePipeline } from "../core/images/prepare.js";
export { clipboardImagePipeline } from "../core/images/prepare.js";

export const MAX_COMPOSER_IMAGES = 8;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export interface ComposerImage {
  id: string;
  mimeType: string;
  data: string;
  width: number;
  height: number;
}

export function composerImageContent(image: ComposerImage): ImageContent {
  return { type: "image", mimeType: image.mimeType, data: image.data };
}

export async function composerImageFromBytes(bytes: Uint8Array): Promise<ComposerImage> {
  return { id: createId("image"), ...await prepareImageBytes(bytes) };
}

export async function composerImageFromPipeline(image: ImagePipeline): Promise<ComposerImage> {
  return { id: createId("image"), ...await prepareImagePipeline(image, { preferPng: true }) };
}

export function candidateImagePaths(text: string): string[] | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const lines = trimmed
    .split(/\r?\n/)
    .map(normalizePathLine)
    .filter((line): line is PathLine => line !== undefined);
  if (lines.length === 0 || lines.length > MAX_COMPOSER_IMAGES) return undefined;
  if (lines.some((line) => line.value.length > 4096 || !looksLikeImagePath(line))) return undefined;
  return lines.map((line) => line.value);
}

export async function composerImagesFromPaths(paths: readonly string[], rootPath: string): Promise<ComposerImage[] | undefined> {
  const resolved: string[] = [];
  for (const candidate of paths) {
    const absolute = path.isAbsolute(candidate) ? candidate : path.resolve(rootPath, candidate);
    try {
      if (!(await stat(absolute)).isFile()) return undefined;
    } catch {
      return undefined;
    }
    resolved.push(absolute);
  }
  const images: ComposerImage[] = [];
  for (const filePath of resolved) {
    const bytes = new Uint8Array(await Bun.file(filePath).arrayBuffer());
    images.push(await composerImageFromBytes(bytes));
  }
  return images;
}

interface PathLine {
  value: string;
  explicit: boolean;
}

function normalizePathLine(line: string): PathLine | undefined {
  let value = line.trim();
  if (!value || value.startsWith("#")) return undefined;
  let explicit = false;
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
    explicit = true;
  }
  if (value.startsWith("file:")) {
    try {
      value = fileURLToPath(value);
      explicit = true;
    } catch {
      return undefined;
    }
  }
  if (value === "~") value = homedir();
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = path.join(homedir(), value.slice(2));
  return value ? { value, explicit } : undefined;
}

function looksLikeImagePath(line: PathLine): boolean {
  const extension = path.extname(line.value).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) return false;
  if (!/\s/.test(line.value) || line.explicit) return true;
  if (line.value.startsWith("/") || line.value.startsWith("\\\\")) return true;
  if (/^[A-Za-z]:[\\/]/.test(line.value)) return true;
  return line.value.includes("/") || line.value.includes("\\");
}
