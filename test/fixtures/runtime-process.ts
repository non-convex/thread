import { open } from "node:fs/promises";
import path from "node:path";
import { tryLock } from "fs-native-extensions";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ThreadRuntime, type ModelClient } from "../../src/runtime.js";

const [mode, rootPath, stateDirectory] = process.argv.slice(2) as [string, string, string];
if (mode === "raw") {
  const handle = await open(path.join(stateDirectory, "session-tree.lock"), "a+");
  if (!tryLock(handle.fd)) throw new Error("Fixture lock was not acquired");
  process.on("message", async () => { await handle.close(); process.exit(0); });
  process.send!({ ready: true });
} else {
  let calls = 0;
  const model: ModelClient = {
    providerId: "test", modelId: "crash-fixture", contextWindow: 128_000, maxOutputTokens: 4096,
    async stream(_context, options) {
      if (++calls === 1) return fauxAssistantMessage(fauxToolCall("read", { path: "note.txt" }), { stopReason: "toolUse" });
      process.send!({ ready: true, sessionId: runtime.initialSessionId });
      await new Promise<void>((resolve) => options.signal.addEventListener("abort", () => resolve(), { once: true }));
      return fauxAssistantMessage(fauxText("interrupted"));
    },
  };
  const runtime = await ThreadRuntime.open({ rootPath, stateDirectory, model, tools: ["read"] });
  process.on("message", async () => { await runtime.close(); process.exit(0); });
  if (mode === "running") void runtime.prompt(runtime.initialSessionId, "recover this input");
  else process.send!({ ready: true });
}
