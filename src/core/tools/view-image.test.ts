import { expect, test } from "bun:test";
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssistantMessage, Context, ImageContent, Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { ModelClient } from "../agent/model-client.js";
import { MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, type ImagePipeline } from "../images/prepare.js";
import { ThreadRuntime } from "../runtime/thread-runtime.js";
import type { RuntimeEvent } from "../runtime/events.js";
import type { HostToolCall } from "../runtime/policy.js";
import type { ToolContext } from "./types.js";
import { viewImageTool } from "./view-image.js";

const pixelImage = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGMUFJb8//f/fwYAD58EOdqXQ4MAAAAASUVORK5CYII=", "base64");
const Image = (Bun as unknown as { Image: new (bytes: Uint8Array) => ImagePipeline }).Image;

async function workspace(run: (directory: string) => Promise<void>): Promise<void> {
  const parent = await realpath(tmpdir());
  const directory = await mkdtemp(path.join(parent, "thread-view-image-"));
  try { await run(directory); } finally {
    if (path.dirname(path.resolve(directory)) !== parent || !path.basename(directory).startsWith("thread-view-image-")) {
      throw new Error("Refusing to clean a path outside the test workspace");
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function toolContext(rootPath: string): ToolContext {
  return { rootPath, acceptsImages: true, signal: new AbortController().signal,
    invocation: { executionId: "test", assistantEntryId: "assistant", toolCallId: "image" } };
}

test("view_image decodes content, resizes large images and supports original dimensions", () => workspace(async (directory) => {
  const large = await new Image(pixelImage).resize(MAX_IMAGE_EDGE * 2, 32, { fit: "fill" }).png().bytes();
  // The extension is deliberately misleading: format detection must use image data.
  await writeFile(path.join(directory, "screenshot.txt"), large);
  const high = await viewImageTool.execute({ path: "screenshot.txt" }, toolContext(directory));
  expect(high.isError).toBe(false);
  expect(high.details).toMatchObject({ width: MAX_IMAGE_EDGE, height: 16, sourceWidth: MAX_IMAGE_EDGE * 2, sourceHeight: 32, resized: true });
  expect(high.images).toHaveLength(1);
  expect(await new Image(Buffer.from(high.images![0]!.data, "base64")).metadata()).toMatchObject({ width: MAX_IMAGE_EDGE, height: 16 });
  expect(high.content).toContain('detail="original"');
  const original = await viewImageTool.execute({ path: "screenshot.txt", detail: "original" }, toolContext(directory));
  expect(original.isError).toBe(false);
  expect(original.details).toMatchObject({ width: MAX_IMAGE_EDGE * 2, height: 32, resized: false });
  expect(await new Image(Buffer.from(original.images![0]!.data, "base64")).metadata()).toMatchObject({ width: MAX_IMAGE_EDGE * 2, height: 32 });
}));

test("view_image rejects unsupported models, invalid files, oversize files and cancellation", () => workspace(async (directory) => {
  const context = toolContext(directory);
  const unavailable = await viewImageTool.execute({ path: "missing.png" }, { ...context, acceptsImages: false });
  expect(unavailable.content).toContain("does not accept images");
  expect(unavailable.images).toBeUndefined();
  await writeFile(path.join(directory, "fake.png"), "not an image");
  await writeFile(path.join(directory, "broken.png"), pixelImage.subarray(0, 40));
  await writeFile(path.join(directory, "empty.png"), "");
  const large = await open(path.join(directory, "large.png"), "w");
  try { await large.truncate(MAX_IMAGE_BYTES + 1); } finally { await large.close(); }
  for (const file of ["fake.png", "broken.png", "empty.png", "large.png", "missing.png", "."]) {
    const result = await viewImageTool.execute({ path: file }, context);
    expect(result.isError).toBe(true);
    expect(result.images).toBeUndefined();
  }
  await expect(viewImageTool.execute({ path: "fake.png" }, { ...context, signal: AbortSignal.abort() })).rejects.toThrow();
}));

const providerModel: Model<"openai-responses"> = {
  id: "vision", name: "Vision", provider: "test", api: "openai-responses", baseUrl: "https://example.invalid",
  input: ["text", "image"], reasoning: false, contextWindow: 1_000_000, maxTokens: 128_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function response(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", content, stopReason, timestamp: Date.now(), api: providerModel.api,
    provider: providerModel.provider, model: providerModel.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

function scriptedModel(requests: Context[], imagePath?: string): ModelClient {
  return { providerId: providerModel.provider, modelId: providerModel.id, acceptsImages: true,
    maxOutputTokens: providerModel.maxTokens, contextWindow: providerModel.contextWindow,
    async stream(context) {
      requests.push(structuredClone(context));
      return imagePath && requests.length === 1
        ? response([{ type: "toolCall", id: "view_1", name: "view_image", arguments: { path: imagePath } }], "toolUse")
        : response([{ type: "text", text: "Done" }], "stop");
    } };
}

function requestImages(context: Context): ImageContent[] {
  return context.messages.flatMap((message) =>
    typeof message.content === "string" ? [] : message.content.filter((block): block is ImageContent => block.type === "image"));
}

test("image pixels reach the next request and survive session restore without leaking into display metadata", () => workspace(async (directory) => {
  const rootPath = path.join(directory, "project");
  const stateDirectory = path.join(directory, "state");
  await mkdir(rootPath);
  const imagePath = path.join(directory, "outside.png");
  await writeFile(imagePath, pixelImage);
  const requests: Context[] = [];
  const events: RuntimeEvent[] = [];
  const permissions: HostToolCall[] = [];
  const options = { rootPath, stateDirectory, tools: ["view_image"] as const };
  let runtime = await ThreadRuntime.open({ ...options, model: scriptedModel(requests, imagePath),
    toolPolicy: (call) => { permissions.push(call); return { allow: true }; } });
  try {
    runtime.subscribe((event) => { events.push(event); });
    runtime.on("tool_result", (event) => ({ ...event, modelContent: `Visible image:\n${event.modelContent}` }));
    const session = await runtime.createSession();
    expect((await runtime.prompt(session.id, "View the screenshot")).outcome).toBe("completed");
    expect(requests).toHaveLength(2);
    const images = requestImages(requests[1]!);
    expect(images).toHaveLength(1);
    expect(await new Image(Buffer.from(images[0]!.data, "base64")).metadata()).toMatchObject({ width: 2, height: 1 });
    expect(permissions[0]!.resources).toEqual([{ namespace: "workspace", resource: process.platform === "win32" ? imagePath.toLowerCase() : imagePath,
      access: "read", scope: "exact" }]);
    const output = convertResponsesMessages(providerModel, requests[1]!, new Set([providerModel.provider]))
      .find((item) => item.type === "function_call_output");
    expect(output).toMatchObject({ output: [
      { type: "input_text", text: expect.stringContaining("Visible image:") },
      { type: "input_image", image_url: `data:${images[0]!.mimeType};base64,${images[0]!.data}` },
    ] });
    let anthropicPayload: unknown;
    const captured = await streamAnthropic({ ...providerModel, api: "anthropic-messages" }, requests[1]!, {
      apiKey: "offline-test", maxRetries: 0,
      onPayload(payload) {
        anthropicPayload = payload;
        throw new Error("Payload captured before network access");
      },
    }).result();
    expect(captured.errorMessage).toBe("Payload captured before network access");
    expect(anthropicPayload).toMatchObject({ messages: expect.arrayContaining([
      expect.objectContaining({ role: "user", content: expect.arrayContaining([
        expect.objectContaining({ type: "tool_result", content: expect.arrayContaining([
          { type: "image", source: { type: "base64", media_type: images[0]!.mimeType, data: images[0]!.data } },
        ]) }),
      ]) }),
    ]) });
    expect(JSON.stringify(events)).not.toContain(images[0]!.data);
    const log = await readFile(path.join(stateDirectory, "session-tree", "events.jsonl"), "utf8");
    expect(log.split(images[0]!.data).length - 1).toBe(1);
    await runtime.close();
    await rm(imagePath); // Restore must replay the saved pixels rather than reread this file.
    const restored: Context[] = [];
    runtime = await ThreadRuntime.open({ ...options, model: scriptedModel(restored) });
    await runtime.prompt(session.id, "Review it again");
    expect(requestImages(restored[0]!)).toEqual(images);
    const textOnly: Context[] = [];
    runtime.setModel({ ...scriptedModel(textOnly), modelId: "text-only", acceptsImages: false });
    await runtime.prompt(session.id, "Summarize the conversation");
    expect(requestImages(textOnly[0]!)).toEqual([]);
    expect(JSON.stringify(textOnly[0])).toContain("image omitted: current model is text-only");
    expect(JSON.stringify(runtime.readSession(session.id))).toContain(images[0]!.data);
  } finally { await runtime.close(); }
}));

test("host denial prevents image attachment and extensions can remove model images", () => workspace(async (directory) => {
  await writeFile(path.join(directory, "sample.png"), pixelImage);
  for (const denied of [true, false]) {
    const requests: Context[] = [];
    const runtime = await ThreadRuntime.open({ rootPath: directory, stateDirectory: path.join(directory, `state-${denied}`),
      model: scriptedModel(requests, "sample.png"), tools: ["view_image"],
      toolPolicy: () => denied ? { allow: false, reason: "Image access denied" } : { allow: true } });
    try {
      if (!denied) runtime.on("tool_result", (event) => ({ ...event, modelContent: "Image withheld", modelImages: [] }));
      const session = await runtime.createSession();
      expect((await runtime.prompt(session.id, "Read image")).outcome).toBe("completed");
      expect(requestImages(requests[1]!)).toEqual([]);
      const result = requests[1]!.messages.find((message) => message.role === "toolResult");
      expect(result).toMatchObject({ isError: denied, content: [{ type: "text", text: denied ? "Image access denied" : "Image withheld" }] });
    } finally { await runtime.close(); }
  }
}));
