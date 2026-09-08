import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Type,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import { ThreadRuntime, type AgentTool, type ModelClient, type ModelRequestOptions } from "thread/runtime";

// An offline host integration: replace this model with your own ModelClient.
class DemoModel implements ModelClient {
  readonly providerId = "demo";
  readonly modelId = "scripted";
  readonly contextWindow = 128_000;
  readonly maxOutputTokens = 8_192;

  async stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage> {
    options.signal.throwIfAborted();
    assert.deepEqual(context.tools?.map((tool) => tool.name).sort(), ["add", "read", "skill"]);
    assert.ok(context.systemPrompt?.startsWith("Answer using this application's tools."));
    assert.match(context.systemPrompt ?? "", /<name>arithmetic<\/name>/);
    const previous = context.messages.at(-1);
    if (previous?.role !== "toolResult") {
      return fauxAssistantMessage([fauxToolCall("skill", { name: "arithmetic" }, { id: "demo-skill" })], {
        stopReason: "toolUse",
      });
    }
    if (previous.isError) throw new Error(`Demo tool failed: ${previous.toolName}`);
    if (previous.toolName === "skill") {
      return fauxAssistantMessage([fauxToolCall("read", { path: "operands.json" }, { id: "demo-read" })], {
        stopReason: "toolUse",
      });
    }
    if (previous.toolName === "read") {
      const operands = JSON.parse(previous.content.filter((item) => item.type === "text").map((item) => item.text).join(""));
      return fauxAssistantMessage([fauxToolCall("add", operands, { id: "demo-add" })], { stopReason: "toolUse" });
    }
    const answer = previous.content.filter((item) => item.type === "text").map((item) => item.text).join("");
    options.onTextDelta?.(`The answer is ${answer}.`);
    return fauxAssistantMessage(fauxText(`The answer is ${answer}.`));
  }
}

const add: AgentTool<{ left: number; right: number }> = {
  name: "add",
  description: "Add two numbers using a capability provided by the host",
  parameters: Type.Object({ left: Type.Number(), right: Type.Number() }),
  replay: "safe",
  execution: { effect: "read", mode: "parallel", resources: () => [] },
  async execute({ left, right }, context) {
    context.signal.throwIfAborted();
    return { content: String(left + right), isError: false };
  },
};

const directory = await mkdtemp(path.join(tmpdir(), "thread-embedding-example-"));
const rootPath = path.join(directory, "workspace");
const stateDirectory = path.join(directory, "state");
let runtime: ThreadRuntime | undefined;
try {
  await mkdir(path.join(rootPath, "skills", "arithmetic"), { recursive: true });
  await writeFile(path.join(rootPath, "operands.json"), JSON.stringify({ left: 20, right: 22 }));
  await writeFile(path.join(rootPath, "skills", "arithmetic", "SKILL.md"), [
    "---",
    "name: arithmetic",
    "description: Add the numbers supplied in the workspace.",
    "---",
    "Read operands.json from the project root and pass its left and right values to the add tool.",
  ].join("\n"));
  runtime = await ThreadRuntime.open({
    rootPath,
    stateDirectory,
    model: new DemoModel(),
    tools: ["read", add],
    systemPrompt: "Answer using this application's tools.",
    skills: { paths: ["./skills"] },
    fileCheckpoints: false,
  });
  const finishedTools: string[] = [];
  const unsubscribe = runtime.subscribe((event) => {
    if (event.type === "assistant_text_delta") process.stdout.write(event.delta);
    if (event.type === "tool_finished") finishedTools.push(event.name);
  });
  const session = await runtime.createSession();
  const result = await runtime.prompt(session.id, "Add the numbers in operands.json.", { maxSteps: 4, timeoutMs: 10_000 });
  unsubscribe();
  console.log(`\nTurn: ${result.outcome}; session: ${session.id}`);
  if (result.outcome !== "completed") throw result.error ?? new Error(`Turn ${result.outcome}`);
  assert.deepEqual(finishedTools, ["skill", "read", "add"]);
  await assert.rejects(access(path.join(stateDirectory, "file-history", "blobs")), { code: "ENOENT" });
  console.log("Selected builtin, custom tool, and declared Skill path verified.");
} finally {
  await runtime?.close();
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  await rm(directory, { recursive: true, force: true });
}
