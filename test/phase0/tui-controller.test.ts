import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { ThreadApp } from "../../src/app.js";
import { PiModelClient } from "../../src/agent/model-client.js";
import {
  ThreadTuiController,
} from "../../src/ui/terminal/controller.js";
import { commitAll, initRepository } from "../helpers/git-fixture.js";

test("the TUI controller commits completed turns and routes documents outside the session screen", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-tui-controller-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "seed.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage([
      fauxThinking("internal reasoning retained in the terminal transcript"),
      fauxText("Completed **smoothly**."),
    ]),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await ThreadApp.open({ rootPath: root, model: new PiModelClient(models, faux.getModel()) });
  const controller = new ThreadTuiController(app);
  const liveKinds: string[][] = [];

  try {
    controller.subscribe(() => {
      const live = controller.state.liveTurn;
      if (live && live.blocks.length > 0) liveKinds.push(live.blocks.map((block) => block.kind));
    });
    await controller.submit("finish the small task");
    assert.equal(controller.state.liveTurn, undefined);
    assert.equal(controller.state.busy, false);
    const transcript = controller.state.transcript;
    assert.equal(transcript[0]?.kind, "user");
    assert.equal(transcript[0]?.content, "finish the small task");
    assert.equal(transcript.filter((item) => item.kind === "user" && item.content === "finish the small task").length, 1);
    assert.ok(transcript.some((item) => item.kind === "thinking" && item.content.includes("internal reasoning")));
    assert.ok(transcript.some((item) => item.kind === "assistant" && item.content === "Completed **smoothly**."));
    assert.ok(transcript.some((item) => item.kind === "tool"));
    const thinkingIndex = transcript.findIndex((item) => item.kind === "thinking");
    const assistantIndex = transcript.findIndex((item) => item.kind === "assistant");
    const toolIndex = transcript.findIndex((item) => item.kind === "tool");
    assert.ok(toolIndex >= 0 && thinkingIndex > toolIndex && assistantIndex > thinkingIndex);
    assert.ok(liveKinds.some((kinds) => kinds.includes("tool")));
    assert.ok(liveKinds.some((kinds) => kinds.includes("thinking") && kinds.includes("assistant")));

    const replayController = new ThreadTuiController(app);
    try {
      const replayed = replayController.state.transcript;
      assert.ok(replayed.some((item) => item.kind === "user"));
      assert.ok(replayed.some((item) => item.kind === "assistant"));
      assert.ok(replayed.some((item) => item.kind === "thinking"));
      assert.ok(replayed.some((item) => item.kind === "tool"), "current-process replay should keep tool traces");
    } finally {
      replayController.dispose();
    }

    await controller.submit("/clear");
    assert.deepEqual(controller.state.transcript, []);

    await controller.submit("/thread status");
    assert.equal(controller.state.screen.type, "document");
    controller.closeView();
    assert.equal(controller.state.screen.type, "session");

    assert.equal(controller.idleCtrlC(), false);
    assert.equal(controller.state.notice?.text, "Press Ctrl+C again to exit");
    await new Promise((resolve) => setTimeout(resolve, 950));
    assert.equal(controller.state.notice, undefined, "the double-Ctrl+C gesture must expire visibly");

    faux.appendResponses([
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return fauxAssistantMessage("late response");
      },
    ]);
    const slowTurn = controller.submit("wait for cancellation");
    await new Promise((resolve) => setTimeout(resolve, 10));
    let stopped = false;
    const stoppedPromise = controller.waitUntilStopped().then(() => { stopped = true; });
    controller.requestStop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false, "renderer shutdown must wait for the active operation to unwind");
    await slowTurn;
    await stoppedPromise;
    assert.equal(stopped, true);
  } finally {
    controller.dispose();
    await app.close();
  }
});
