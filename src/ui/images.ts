import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageContent } from "@earendil-works/pi-ai";
import { createId } from "../utils/id.js";

export const MAX_COMPOSER_IMAGES = 8;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 20_000_000;
export const MAX_IMAGE_EDGE = 1568;
const JPEG_QUALITY = 80;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export interface ComposerImage {
  id: string;
  mimeType: string;
  data: string;
  width: number;
  height: number;
}

interface BunImageMetadata {
  width: number;
  height: number;
  format: string;
  hasAlpha?: boolean;
}

interface BunImagePipeline {
  metadata(): Promise<BunImageMetadata>;
  resize(width: number, height: number, options?: {
    fit?: "fill" | "inside";
    withoutEnlargement?: boolean;
  }): BunImagePipeline;
  jpeg(options?: { quality?: number }): BunImagePipeline;
  png(options?: {
    compressionLevel?: number;
    palette?: boolean;
    colors?: number;
    dither?: boolean;
  }): BunImagePipeline;
  bytes(): Promise<Uint8Array>;
}

interface BunImageConstructor {
  new (input: Uint8Array, options?: { maxPixels?: number }): BunImagePipeline;
  fromClipboard?: () => BunImagePipeline | null;
}

function bunImage(): BunImageConstructor | undefined {
  return (Bun as { Image?: BunImageConstructor }).Image;
}

export function composerImageContent(image: ComposerImage): ImageContent {
  return { type: "image", mimeType: image.mimeType, data: image.data };
}

export function clipboardImagePipeline(): BunImagePipeline | null {
  const Image = bunImage();
  if (!Image?.fromClipboard) return null;
  return Image.fromClipboard() ?? null;
}

export async function composerImageFromBytes(bytes: Uint8Array): Promise<ComposerImage> {
  if (bytes.byteLength === 0) throw new Error("Image is empty");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image is larger than 8 MB");
  const Image = bunImage();
  if (!Image) throw new Error("Image processing is unavailable in this Bun build");
  const source = new Uint8Array(bytes);
  const pipeline = new Image(source, { maxPixels: MAX_IMAGE_PIXELS });
  const meta = await pipeline.metadata();
  assertImageDimensions(meta);
  if (Math.max(meta.width, meta.height) <= MAX_IMAGE_EDGE && !shouldReencode(meta.format, source.byteLength)) {
    return composerImage(source, mimeFor(meta.format, source), meta);
  }
  return encodePipelineForModel(pipeline, meta, Image);
}

export async function composerImageFromPipeline(image: BunImagePipeline): Promise<ComposerImage> {
  const Image = bunImage();
  if (!Image) throw new Error("Image processing is unavailable in this Bun build");
  const meta = await image.metadata();
  assertImageDimensions(meta);
  return encodePipelineForModel(image, meta, Image, true);
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

async function encodePipelineForModel(
  source: BunImagePipeline,
  meta: BunImageMetadata,
  Image: BunImageConstructor,
  preferPng = false,
): Promise<ComposerImage> {
  let pipeline = source;
  if (Math.max(meta.width, meta.height) > MAX_IMAGE_EDGE) {
    pipeline = pipeline.resize(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE, { fit: "inside", withoutEnlargement: true });
  }
  const png = preferPng || meta.hasAlpha === true || ["png", "gif", "bmp"].includes(meta.format);
  const encoded = png
    ? await pipeline.png({ compressionLevel: 6, palette: true, colors: 256, dither: false }).bytes()
    : await pipeline.jpeg({ quality: JPEG_QUALITY }).bytes();
  if (encoded.byteLength > MAX_IMAGE_BYTES) throw new Error("Processed image is larger than 8 MB");
  const outMeta = await new Image(encoded, { maxPixels: MAX_IMAGE_PIXELS }).metadata();
  return composerImage(encoded, png ? "image/png" : "image/jpeg", outMeta);
}

function composerImage(bytes: Uint8Array, mimeType: string, meta: BunImageMetadata): ComposerImage {
  return {
    id: createId("image"),
    mimeType,
    data: Buffer.from(bytes).toString("base64"),
    width: meta.width,
    height: meta.height,
  };
}

function assertImageDimensions(meta: BunImageMetadata): void {
  if (!Number.isInteger(meta.width) || !Number.isInteger(meta.height) || meta.width <= 0 || meta.height <= 0) {
    throw new Error("Image has invalid dimensions");
  }
  if (meta.width * meta.height > MAX_IMAGE_PIXELS) {
    throw new Error("Image is larger than the 20 megapixel limit");
  }
}

function shouldReencode(format: string, bytes: number): boolean {
  if (format !== "png" && format !== "jpeg" && format !== "webp" && format !== "gif") return true;
  return bytes > 400_000;
}

function mimeFor(format: string, bytes: Uint8Array): string {
  if (format === "jpeg" || format === "jpg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  if (format === "gif") return "image/gif";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return "image/png";
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
