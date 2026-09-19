import { open } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, prepareImageBytes } from "../images/prepare.js";
import { fileAccess, prepareFilePath, resolveToolPath } from "./execution.js";
import { fail } from "./results.js";
import type { AgentTool } from "./types.js";

type ViewImageArgs = { path: string; detail?: "high" | "original" };

/** Bound the allocation and read even if a file grows after stat. */
async function readImage(path: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    signal.throwIfAborted();
    if (!info.isFile()) throw new Error(`Not a file: ${path}`);
    if (!info.size) throw new Error("Image is empty");
    if (info.size > MAX_IMAGE_BYTES) throw new Error("Image is larger than 8 MB; use a smaller image or crop");
    const bytes = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < bytes.length) {
      signal.throwIfAborted();
      const read = await file.read(bytes, used, bytes.length - used, used);
      signal.throwIfAborted();
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    if (used > info.size) throw new Error("Image changed while reading; retry the tool call");
    return bytes.subarray(0, used);
  } finally { await file.close(); }
}

export const viewImageTool: AgentTool<ViewImageArgs> = {
  name: "view_image",
  description: `View a local PNG, JPEG, WebP, GIF or BMP image by attaching its pixels to the tool result. Requires a model that accepts images. Relative and absolute paths, including paths outside the project, are allowed. Default high detail resizes to at most ${MAX_IMAGE_EDGE} pixels on the longest edge; use original to preserve dimensions for small text or fine details. Animated images use the first frame. Maximum input/output 8 MB and 20 megapixels. A screenshot path returned by another tool is not visually inspected until this tool succeeds.`,
  parameters: Type.Object({
    path: Type.String({ description: "Local image file to view; not a URL." }),
    detail: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("original")], {
      description: "high (default) resizes large images; original preserves pixel dimensions.",
    })),
  }),
  replay: "safe",
  prepare: (args, context) => prepareFilePath(args, context),
  execution: fileAccess("read"),
  async execute(args, context) {
    try {
      context.signal.throwIfAborted();
      if (context.acceptsImages !== true) throw new Error("Current model does not accept images. Select a vision model before using view_image.");
      const target = await resolveToolPath(context, args.path);
      const image = await prepareImageBytes(await readImage(target, context.signal), {
        original: args.detail === "original", signal: context.signal,
      });
      const resized = image.width !== image.sourceWidth || image.height !== image.sourceHeight;
      return {
        content: `Image attached: ${args.path} (${image.mimeType}, ${image.width}×${image.height})` +
          (resized ? `\nResized from ${image.sourceWidth}×${image.sourceHeight}. Coordinates refer to the displayed image; use detail="original" for source dimensions.` : ""),
        images: [{ type: "image", data: image.data, mimeType: image.mimeType }],
        isError: false,
        details: { path: target, width: image.width, height: image.height, sourceWidth: image.sourceWidth,
          sourceHeight: image.sourceHeight, mimeType: image.mimeType, resized },
      };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return fail(error);
    }
  },
};
