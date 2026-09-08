import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Type, fauxAssistantMessage, fauxText, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { ThreadApp, type ThreadAppOptions } from "../src/app/thread-app.js";
import { loadProjectInstructions, PROJECT_INSTRUCTIONS_MAX_BYTES } from "../src/app/project-instructions.js";
import { ThreadRuntime, type AgentTool, type ModelClient } from "../src/runtime.js";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-project-instructions-"));
  const rootPath = path.join(directory, "project");
  await mkdir(rootPath);
  return { directory, rootPath, stateDirectory: path.join(directory, "state"),
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) };
}

function model(stream: ModelClient["stream"]): ModelClient {
  return { modelId: "project-instructions", providerId: "fixture", contextWindow: 128_000, maxOutputTokens: 8192, stream };
}

test("coding main and workers share root instructions captured at startup, including workers enabled later", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await mkdir(path.join(f.rootPath, "nested"));
  await writeFile(path.join(f.directory, "AGENTS.md"), "ANCESTOR_MUST_NOT_LOAD");
  await writeFile(path.join(f.rootPath, "nested", "AGENTS.md"), "NESTED_MUST_NOT_LOAD");
  const source = path.join(f.rootPath, "AGENTS.md");
  await writeFile(source, "PROJECT_RULES_V1");
  const mainContexts: Context[] = [];
  const workerContexts: Context[] = [];
  const worker = model(async (context) => { workerContexts.push(structuredClone(context)); return fauxAssistantMessage(fauxText("worker done")); });
  const main = model(async (context) => {
    mainContexts.push(structuredClone(context));
    const last = context.messages.at(-1);
    if (last?.role === "user" && last.content === "delegate") return fauxAssistantMessage(fauxToolCall("delegate_tasks", { tasks: [{
      title: "Read instructions", objective: "Follow project guidance", guidance: ["Use the shared instructions."],
      acceptanceCriteria: ["Report completion."], writeScope: [{ path: "allowed.txt", kind: "file" }],
    }] }), { stopReason: "toolUse" });
    if (last?.role === "toolResult" && last.toolName === "delegate_tasks") {
      const payload = JSON.parse(last.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
      return fauxAssistantMessage(fauxToolCall("wait_tasks", { taskIds: payload.tasks.map((task: { taskId: string }) => task.taskId), returnWhen: "all" }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(fauxText("done"));
  });
  const options: ThreadAppOptions = { ...f, model: main, search: false, globalMemoryPath: false, skills: { paths: [] },
    systemPrompt: "MAIN_ROLE_ONLY", sharedInstructions: "HOST_SHARED_RULES", implementationWorker: { enabled: true, model: worker } };
  let app = await ThreadApp.open(options);
  try {
    await writeFile(source, "PROJECT_RULES_V2");
    options.sharedInstructions = "MUTATED_AFTER_OPEN";
    assert.equal((await app.handleInput("delegate", { signal: new AbortController().signal })).kind, "turn");
    app.runtime.configureAgent("implementation-worker", false);
    app.runtime.configureAgent("implementation-worker", true, worker);
    await app.handleInput("/new", { signal: new AbortController().signal });
    await app.handleInput("delegate", { signal: new AbortController().signal });
    assert.equal(workerContexts.length, 2);
    for (const context of [...mainContexts, ...workerContexts]) {
      assert.ok(context.systemPrompt?.includes(source));
      assert.match(context.systemPrompt!, /HOST_SHARED_RULES/);
      assert.equal(context.systemPrompt!.split("PROJECT_RULES_V1").length - 1, 1);
      assert.doesNotMatch(context.systemPrompt!, /ANCESTOR_MUST_NOT_LOAD|NESTED_MUST_NOT_LOAD|PROJECT_RULES_V2|MUTATED_AFTER_OPEN/);
    }
    assert.ok(mainContexts.every((context) => context.systemPrompt?.startsWith("MAIN_ROLE_ONLY")));
    assert.ok(workerContexts.every((context) => !context.systemPrompt?.includes("MAIN_ROLE_ONLY")));
    await app.close();
    app = await ThreadApp.open({ ...options, sharedInstructions: "HOST_SHARED_RULES" });
    await app.handleInput("hello", { signal: new AbortController().signal });
    assert.match(mainContexts.at(-1)!.systemPrompt!, /PROJECT_RULES_V2/);
    assert.doesNotMatch(mainContexts.at(-1)!.systemPrompt!, /PROJECT_RULES_V1/);
  } finally { await app.close(); }
});

test("core does not discover project files, and the coding application can opt out", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await writeFile(path.join(f.rootPath, "AGENTS.md"), "PROJECT_MUST_NOT_LOAD");
  const contexts: Context[] = [];
  const client = model(async (context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage(fauxText("done")); });
  const runtime = await ThreadRuntime.open({ ...f, model: client, systemPrompt: "Host", sharedInstructions: "Shared" });
  try {
    await runtime.prompt(runtime.initialSessionId, "hello");
    assert.equal(contexts[0]?.systemPrompt, "Host\n\nShared");
  } finally { await runtime.close(); }
  const app = await ThreadApp.open({ ...f, model: client, projectInstructions: false, search: false, globalMemoryPath: false, skills: { paths: [] } });
  try {
    await app.handleInput("hello", { signal: new AbortController().signal });
    assert.doesNotMatch(contexts.at(-1)!.systemPrompt!, /PROJECT_MUST_NOT_LOAD/);
  } finally { await app.close(); }
});

test("project instruction reads are bounded, reject unreadable content, and leave no partially opened state", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const source = path.join(f.rootPath, "AGENTS.md");
  assert.equal(await loadProjectInstructions(f.rootPath), "");
  await writeFile(source, "\ufeff \n");
  assert.equal(await loadProjectInstructions(f.rootPath), "");
  await writeFile(source, "a".repeat(PROJECT_INSTRUCTIONS_MAX_BYTES));
  assert.ok((await loadProjectInstructions(f.rootPath)).endsWith("a".repeat(PROJECT_INSTRUCTIONS_MAX_BYTES)));
  await writeFile(source, "a".repeat(PROJECT_INSTRUCTIONS_MAX_BYTES + 1));
  await assert.rejects(ThreadApp.open(f), /AGENTS.md exceeds.*keep project instructions short/);
  await assert.rejects(stat(f.stateDirectory), { code: "ENOENT" });
  await writeFile(source, Buffer.from([0xff]));
  await assert.rejects(loadProjectInstructions(f.rootPath), /Cannot load project instructions/);
  await rm(source);
  await mkdir(source);
  await assert.rejects(loadProjectInstructions(f.rootPath), /regular file|EISDIR/);
});

test("project instruction discovery refuses a link outside the declared project", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const outsideDirectory = path.join(f.directory, "private");
  await mkdir(outsideDirectory);
  const outside = path.join(outsideDirectory, "instructions.md");
  await writeFile(outside, "OUTSIDE_RULES");
  // Windows junctions exercise confinement without requiring file-symlink privileges.
  await symlink(process.platform === "win32" ? outsideDirectory : outside,
    path.join(f.rootPath, "AGENTS.md"), process.platform === "win32" ? "junction" : "file");
  await assert.rejects(loadProjectInstructions(f.rootPath), /outside workspace/);
  assert.equal(await readFile(outside, "utf8"), "OUTSIDE_RULES");
});

test("asynchronous application startup captures host options before reading project instructions", async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await writeFile(path.join(f.rootPath, "AGENTS.md"), "PROJECT_RULE");
  const contexts: Context[] = [];
  const tool: AgentTool = { name: "host", description: "ORIGINAL_TOOL", parameters: Type.Object({ value: Type.String() }), replay: "safe",
    execution: { effect: "read", mode: "parallel", resources: () => [] }, async execute() { return { content: "ok", isError: false }; } };
  const options: ThreadAppOptions = { ...f, tools: [tool], skills: { paths: [] }, search: false, globalMemoryPath: false,
    sharedInstructions: "ORIGINAL_SHARED", model: model(async (context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage(fauxText("done")); }) };
  const opening = ThreadApp.open(options);
  tool.description = "MUTATED_TOOL";
  options.sharedInstructions = "MUTATED_SHARED";
  const app = await opening;
  try {
    await app.handleInput("hello", { signal: new AbortController().signal });
    assert.match(contexts[0]!.systemPrompt!, /ORIGINAL_SHARED/);
    assert.doesNotMatch(contexts[0]!.systemPrompt!, /MUTATED_SHARED/);
    assert.equal(contexts[0]!.tools?.find((item) => item.name === "host")?.description, "ORIGINAL_TOOL");
  } finally { await app.close(); }
});
