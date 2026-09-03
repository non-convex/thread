import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxText,
  type AssistantMessage,
  type Context,
  type ImageContent,
} from "@earendil-works/pi-ai";
import { PasteEvent } from "@opentui/core";
import type {
  ModelCatalog,
  ModelClient,
  ModelDescriptor,
  ModelRequestOptions,
} from "../src/agent/model-client.js";
import { ThreadApp } from "../src/app.js";
import { isSlashCommandInput } from "../src/app/input-router.js";
import {
  messageWithoutImages,
  userContentDisplay,
  userContentFrom,
} from "../src/session-tree/user-content.js";
import {
  candidateImagePaths,
  composerImageFromBytes,
  composerImagesFromPaths,
  MAX_IMAGE_BYTES,
  type ComposerImage,
} from "../src/ui/images.js";
import { handleComposerPaste, pasteHostClipboardImage, type ComposerPasteHost } from "../src/ui/terminal/composer-paste.js";
import type { HostClipboardService } from "@opentui/core";
import { projectTranscript } from "../src/ui/terminal/transcript-projection.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const IMAGE: ImageContent = {
  type: "image",
  mimeType: "image/png",
  data: ONE_PIXEL_PNG.toString("base64"),
};

class CapturingModel implements ModelClient {
  readonly providerId = "test";
  readonly contextWindow = 128_000;
  readonly maxOutputTokens = 8_192;
  readonly reasoning = false;
  readonly contexts: Context[] = [];

  constructor(readonly modelId: string, readonly acceptsImages: boolean) {}

  async stream(context: Context, _options: ModelRequestOptions): Promise<AssistantMessage> {
    this.contexts.push(structuredClone(context));
    return fauxAssistantMessage(fauxText("ok"));
  }
}

class ImageTestCatalog implements ModelCatalog {
  constructor(private readonly clients: readonly CapturingModel[]) {}

  list(providerId?: string): ModelDescriptor[] {
    return this.clients.filter((model) => !providerId || model.providerId === providerId).map((model) => ({
      providerId: model.providerId,
      modelId: model.modelId,
      name: model.modelId,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      reasoning: model.reasoning,
      acceptsImages: model.acceptsImages,
    }));
  }

  createClient(providerId: string, modelId: string): ModelClient {
    const model = this.clients.find((item) => item.providerId === providerId && item.modelId === modelId);
    if (!model) throw new Error(`Unknown model ${providerId}/${modelId}`);
    return model;
  }
}

async function fixture(prefix: string): Promise<{ root: string; home: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const root = path.join(directory, "project");
  const home = path.join(directory, "thread-home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  return {
    root,
    home,
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

async function withThreadHome<T>(home: string, operation: () => Promise<T>): Promise<T> {
  const before = process.env.THREAD_HOME;
  process.env.THREAD_HOME = home;
  try {
    return await operation();
  } finally {
    if (before === undefined) delete process.env.THREAD_HOME;
    else process.env.THREAD_HOME = before;
  }
}

test("the composer distinguishes slash commands from absolute paths", () => {
  assert.equal(isSlashCommandInput("/model"), true);
  assert.equal(isSlashCommandInput("/unknown value"), true);
  assert.equal(isSlashCommandInput("/usr/bin/env"), false);
});

test("user image content keeps model bytes but displays a small marker", () => {
  const content = userContentFrom("describe this", [IMAGE]);
  assert.ok(Array.isArray(content));
  assert.deepEqual(content, [IMAGE, { type: "text", text: "describe this" }]);
  assert.equal(userContentDisplay(content), "[image]\ndescribe this");

  const textOnly = messageWithoutImages({ role: "user", content, timestamp: 1 });
  assert.deepEqual(textOnly.content, [
    { type: "text", text: "[image omitted: current model is text-only]" },
    { type: "text", text: "describe this" },
  ]);
});

test("clipboard and path images are decoded into composer attachments", async (t) => {
  const values = await fixture("thread-image-input-");
  t.after(values.cleanup);
  const imagePath = path.join(values.root, "screen shot.png");
  await writeFile(imagePath, ONE_PIXEL_PNG);

  const direct = await composerImageFromBytes(ONE_PIXEL_PNG);
  assert.equal(direct.mimeType, "image/png");
  assert.equal(direct.width, 1);
  assert.equal(direct.height, 1);
  assert.equal(Buffer.from(direct.data, "base64").compare(ONE_PIXEL_PNG), 0);

  assert.deepEqual(candidateImagePaths(`"${imagePath}"`), [imagePath]);
  assert.deepEqual(candidateImagePaths("'screen shot.png'"), ["screen shot.png"]);
  assert.equal(candidateImagePaths("look at screen.png in this sentence"), undefined);
  const loaded = await composerImagesFromPaths([imagePath], values.root);
  assert.equal(loaded?.length, 1);
  assert.equal(loaded?.[0]?.width, 1);

  await assert.rejects(
    composerImageFromBytes(new Uint8Array(MAX_IMAGE_BYTES + 1)),
    /larger than 8 MB/,
  );
});

test("paste events are stopped before an image path is loaded", async (t) => {
  const values = await fixture("thread-image-paste-event-");
  t.after(values.cleanup);
  const imagePath = path.join(values.root, "screen.png");
  await writeFile(imagePath, ONE_PIXEL_PNG);
  let attachments: ComposerImage[] = [];
  let inserted = "";
  const host: ComposerPasteHost = {
    rootPath: values.root,
    attachments: () => attachments,
    setAttachments: (images) => { attachments = images; },
    insertText: (text) => { inserted += text; },
    note: () => undefined,
  };

  const imageEvent = new PasteEvent(new TextEncoder().encode(imagePath), { kind: "text" });
  const pending = handleComposerPaste(host, imageEvent);
  assert.equal(imageEvent.defaultPrevented, true);
  assert.equal(await pending, true);
  assert.equal(attachments.length, 1);
  assert.equal(inserted, "");

  const textEvent = new PasteEvent(new TextEncoder().encode("ordinary text"), { kind: "text" });
  assert.equal(await handleComposerPaste(host, textEvent), false);
  assert.equal(textEvent.defaultPrevented, false);
});

function recordingHost(rootPath: string, clipboard: { mimeType: string; bytes: Uint8Array }): {
  state: { attachments: ComposerImage[]; notes: string[]; inserted: string[] };
  host: ComposerPasteHost;
} {
  const state = {
    attachments: [] as ComposerImage[],
    notes: [] as string[],
    inserted: [] as string[],
  };
  const service = {
    read: async () => ({ status: "read", representation: clipboard }),
  } as unknown as HostClipboardService;
  return {
    state,
    host: {
      rootPath,
      attachments: () => state.attachments,
      setAttachments: (images) => { state.attachments = images; },
      insertText: (text) => { state.inserted.push(text); },
      note: (text) => { state.notes.push(text); },
      hostClipboard: service,
    },
  };
}

test("the Alt+V clipboard read attaches images and never inserts text", async (t) => {
  const values = await fixture("thread-alt-v-");
  t.after(values.cleanup);

  const image = recordingHost(values.root, { mimeType: "image/png", bytes: ONE_PIXEL_PNG });
  assert.equal(await pasteHostClipboardImage(image.host), true);
  assert.equal(image.state.attachments.length, 1);
  assert.deepEqual(image.state.inserted, []);

  const text = recordingHost(values.root, {
    mimeType: "text/plain",
    bytes: new TextEncoder().encode("just words"),
  });
  assert.equal(await pasteHostClipboardImage(text.host), false);
  assert.deepEqual(text.state.attachments, []);
  assert.deepEqual(text.state.inserted, []);
});

test("vision turns reach the model and remain visible in Session Tree history", async (t) => {
  const values = await fixture("thread-vision-turn-");
  t.after(values.cleanup);
  await withThreadHome(values.home, async () => {
    const model = new CapturingModel("vision", true);
    const app = await ThreadApp.open({
      rootPath: values.root,
      model,
      skills: { skills: [], diagnostics: [] },
    });
    try {
      const result = await app.handleInput("describe this", {
        signal: new AbortController().signal,
        images: [IMAGE],
      });
      assert.equal(result.kind, "turn");
      assert.equal(model.contexts.length, 1);
      const sent = model.contexts[0]!.messages.find((message) => message.role === "user");
      assert.ok(sent && Array.isArray(sent.content));
      assert.deepEqual(sent.content, [IMAGE, { type: "text", text: "describe this" }]);

      const messages = app.sessionTree.messagesForTurn(result.kind === "turn" ? result.result.turn.id : "");
      assert.deepEqual(messages[0]?.content, [IMAGE, { type: "text", text: "describe this" }]);
      assert.equal(app.sessionTree.rewindCandidates()[0]?.label, "[image] describe this");
      assert.equal(app.search.search(["[image]"]).totalMatchingTurns, 1);

      const entries = app.sessionTree.entriesForTurn(result.kind === "turn" ? result.result.turn.id : "");
      assert.equal(projectTranscript(entries)[0]?.content, "[image]\ndescribe this");
    } finally {
      await app.close();
    }
  });
});

test("text-only models reject a newly attached image before opening a turn", async (t) => {
  const values = await fixture("thread-text-only-image-");
  t.after(values.cleanup);
  await withThreadHome(values.home, async () => {
    const model = new CapturingModel("text", false);
    const app = await ThreadApp.open({
      rootPath: values.root,
      model,
      skills: { skills: [], diagnostics: [] },
    });
    try {
      await assert.rejects(
        app.handleInput("describe this", {
          signal: new AbortController().signal,
          images: [IMAGE],
        }),
        /does not accept images/,
      );
      assert.equal(app.sessionTree.activeLiveTip, null);
      assert.equal(model.contexts.length, 0);
    } finally {
      await app.close();
    }
  });
});

test("old image turns become markers after switching to a text-only model", async (t) => {
  const values = await fixture("thread-image-model-switch-");
  t.after(values.cleanup);
  await withThreadHome(values.home, async () => {
    const vision = new CapturingModel("vision", true);
    const text = new CapturingModel("text", false);
    const app = await ThreadApp.open({
      rootPath: values.root,
      model: vision,
      modelCatalog: new ImageTestCatalog([vision, text]),
      skills: { skills: [], diagnostics: [] },
    });
    try {
      await app.handleInput("first", {
        signal: new AbortController().signal,
        images: [IMAGE],
      });
      await app.handleInput("/model test/text", { signal: new AbortController().signal });
      await app.handleInput("continue", { signal: new AbortController().signal });

      const replayed = text.contexts[0]!.messages.filter((message) => message.role === "user");
      assert.equal(replayed.length, 2);
      assert.deepEqual(replayed[0]?.content, [
        { type: "text", text: "[image omitted: current model is text-only]" },
        { type: "text", text: "first" },
      ]);
      assert.equal(replayed[1]?.content, "continue");
    } finally {
      await app.close();
    }
  });
});
