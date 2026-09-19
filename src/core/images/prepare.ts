export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 20_000_000;
export const MAX_IMAGE_EDGE = 1568;
const JPEG_QUALITY = 80;

export interface PreparedImage {
  mimeType: string;
  data: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

interface ImageMetadata {
  width: number;
  height: number;
  format: string;
  hasAlpha?: boolean;
}

export interface ImagePipeline {
  metadata(): Promise<ImageMetadata>;
  resize(width: number, height: number, options?: {
    fit?: "fill" | "inside";
    withoutEnlargement?: boolean;
  }): ImagePipeline;
  jpeg(options?: { quality?: number }): ImagePipeline;
  png(options?: { compressionLevel?: number }): ImagePipeline;
  bytes(): Promise<Uint8Array>;
}

interface ImageConstructor {
  new (input: Uint8Array, options?: { maxPixels?: number }): ImagePipeline;
  fromClipboard?: () => ImagePipeline | null;
}

interface ImageOptions {
  /** Preserve pixel dimensions, with lossless PNG encoding. Provider limits still apply. */
  original?: boolean;
  preferPng?: boolean;
  signal?: AbortSignal;
}

function imageConstructor(): ImageConstructor {
  const Image = (Bun as { Image?: ImageConstructor }).Image;
  if (!Image) throw new Error("Image processing is unavailable in this Bun build");
  return Image;
}

export function clipboardImagePipeline(): ImagePipeline | null {
  return (Bun as { Image?: ImageConstructor }).Image?.fromClipboard?.() ?? null;
}

export async function prepareImageBytes(bytes: Uint8Array, options: ImageOptions = {}): Promise<PreparedImage> {
  options.signal?.throwIfAborted();
  if (!bytes.byteLength) throw new Error("Image is empty");
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Image is larger than 8 MB");
  const Image = imageConstructor();
  const source = new Image(new Uint8Array(bytes), { maxPixels: MAX_IMAGE_PIXELS });
  const meta = await source.metadata();
  options.signal?.throwIfAborted();
  if (!["png", "jpeg", "jpg", "webp", "gif", "bmp"].includes(meta.format)) {
    throw new Error(`Unsupported image format: ${meta.format}. Use PNG, JPEG, WebP, GIF or BMP.`);
  }
  return prepareImagePipeline(source, options);
}

/** Decode before returning pixels; even small images must not pass through with corrupt image data. */
export async function prepareImagePipeline(source: ImagePipeline, options: ImageOptions = {}): Promise<PreparedImage> {
  options.signal?.throwIfAborted();
  const meta = await source.metadata();
  options.signal?.throwIfAborted();
  if (!Number.isInteger(meta.width) || !Number.isInteger(meta.height) || meta.width <= 0 || meta.height <= 0) {
    throw new Error("Image has invalid dimensions");
  }
  if (meta.width * meta.height > MAX_IMAGE_PIXELS) throw new Error("Image is larger than the 20 megapixel limit");
  let pipeline = source;
  if (!options.original && Math.max(meta.width, meta.height) > MAX_IMAGE_EDGE) {
    pipeline = pipeline.resize(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE, { fit: "inside", withoutEnlargement: true });
  }
  // Keep screenshot text and original-detail pixels lossless. Animated formats use the first frame.
  const png = options.original || options.preferPng || meta.hasAlpha === true || ["png", "webp", "gif", "bmp"].includes(meta.format);
  const encoded = png
    ? await pipeline.png({ compressionLevel: 6 }).bytes()
    : await pipeline.jpeg({ quality: JPEG_QUALITY }).bytes();
  options.signal?.throwIfAborted();
  if (encoded.byteLength > MAX_IMAGE_BYTES) throw new Error("Processed image is larger than 8 MB; use a smaller image or crop");
  const Image = imageConstructor();
  const outMeta = await new Image(encoded, { maxPixels: MAX_IMAGE_PIXELS }).metadata();
  options.signal?.throwIfAborted();
  return {
    mimeType: png ? "image/png" : "image/jpeg",
    data: Buffer.from(encoded).toString("base64"),
    width: outMeta.width,
    height: outMeta.height,
    sourceWidth: meta.width,
    sourceHeight: meta.height,
  };
}
