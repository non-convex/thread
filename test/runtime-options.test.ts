import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Type, fauxAssistantMessage, fauxText, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { ThreadRuntime, type AgentTool, type BuiltinToolName, type ModelClient, type ThreadRuntimeOptions } from "../src/runtime.js";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-options-"));
  const rootPath = path.join(directory, "project");
  const stateDirectory = path.join(directory, "state");
  await mkdir(rootPath);
  return { directory, rootPath, stateDirectory,
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) };
}

function model(respond?: ModelClient["stream"]) {
  const contexts: Context[] = [];
  const client: ModelClient = {
    modelId: "options", providerId: "test", contextWindow: 128_000, maxOutputTokens: 8_192,
    async stream(context, options) {
      contexts.push(structuredClone(context));
      return respond ? respond(context, options) : fauxAssistantMessage(fauxText("done"));
    },
  };
  return { client, contexts };
}

function customTool(name = "lookup"): AgentTool {
  return {
    name, description: "Look up a host value", parameters: Type.Object({}), replay: "safe",
    execution: { effect: "read", mode: "parallel", resources: () => [] },
    async execute() { return { content: "host-value", isError: false }; },
  };
}

async function skill(root: string, name: string, body: string, manual = false) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Instructions for ${name}\n${manual ? "disable-model-invocation: true\n" : ""}---\n${body}\n`);
  return directory;
}

test("bare runtime ignores global skills and starts with no tools or product instructions", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const home = path.join(values.directory, "default-home");
  await skill(path.join(home, "skills"), "global-only", "MUST_NOT_LOAD");
  const previousHome = process.env.THREAD_HOME;
  process.env.THREAD_HOME = home;
  const { client, contexts } = model();
  let runtime: ThreadRuntime | undefined;
  try {
    runtime = await ThreadRuntime.open({ ...values, model: client });
    assert.equal(runtime.fileCheckpoints, false);
    assert.deepEqual(runtime.skills, []);
    assert.equal((await runtime.prompt(runtime.initialSessionId, "hello")).outcome, "completed");
    assert.equal(contexts[0]?.systemPrompt, "");
    assert.deepEqual(contexts[0]?.tools, []);
  } finally {
    await runtime?.close();
    if (previousHome === undefined) delete process.env.THREAD_HOME;
    else process.env.THREAD_HOME = previousHome;
  }
});

test("selected builtin tools execute alongside host tools and can be extended after open", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  await writeFile(path.join(values.rootPath, "input.txt"), "local-value");
  let calls = 0;
  const { client, contexts } = model(async () => ++calls === 1
    ? fauxAssistantMessage([
      fauxToolCall("read", { path: "input.txt" }, { id: "read-local" }),
      fauxToolCall("lookup", {}, { id: "host-lookup" }),
    ], { stopReason: "toolUse" })
    : fauxAssistantMessage(fauxText("done")));
  const systemPrompt = "  Host instructions.\nPreserve this prefix exactly.\n";
  const runtime = await ThreadRuntime.open({ ...values, model: client, tools: ["read", "websearch", customTool()], systemPrompt });
  try {
    const result = await runtime.prompt(runtime.initialSessionId, "read and look up");
    assert.equal(result.outcome, "completed");
    assert.deepEqual(contexts[0]?.tools?.map((tool) => tool.name), ["read", "websearch", "lookup"]);
    assert.equal(contexts[0]?.systemPrompt, systemPrompt);
    const results = contexts[1]!.messages.filter((message) => message.role === "toolResult");
    assert.equal(results.length, 2);
    assert.ok(results.every((message) => !message.isError));
    assert.match(JSON.stringify(results), /local-value/);
    assert.match(JSON.stringify(results), /host-value/);
    assert.throws(() => runtime.registerTool(customTool("read")), /already registered/);
    const remove = runtime.registerTool(customTool("later"));
    await runtime.prompt(runtime.initialSessionId, "updated tools");
    assert.ok(contexts.at(-1)?.tools?.some((tool) => tool.name === "later"));
    remove();
    await runtime.prompt(runtime.initialSessionId, "removed tools");
    assert.ok(!contexts.at(-1)?.tools?.some((tool) => tool.name === "later"));
  } finally { await runtime.close(); }
});

test("tool selections reject unknown and duplicate names without leaving a runtime lock", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  for (const tools of [["missing"], ["constructor"], ["read", "read"], ["read", customTool("read")]]) {
    await assert.rejects(ThreadRuntime.open({ ...values, tools: tools as ThreadRuntimeOptions["tools"] }),
      /Unknown builtin tool|already registered/);
  }
  const builtins: BuiltinToolName[] = ["read", "list", "grep", "write", "edit", "bash", "websearch", "webfetch"];
  const { client, contexts } = model();
  const runtime = await ThreadRuntime.open({ ...values, tools: builtins, model: client });
  try {
    await runtime.prompt(runtime.initialSessionId, "available tools");
    assert.deepEqual(contexts[0]?.tools?.map((tool) => tool.name), builtins);
  } finally { await runtime.close(); }
});

test("tool snapshots retain class execution state and isolate parameter schemas on open and register", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  class StatefulTool implements AgentTool<{ value: string }> {
    readonly name = "stateful";
    description = "Original description";
    readonly parameters = Type.Object({ value: Type.String() });
    readonly replay = "safe";
    readonly execution = { effect: "read" as const, mode: "parallel" as const, resources: () => [] };
    #calls = 0;
    get calls() { return this.#calls; }
    async execute({ value }: { value: string }) {
      this.#calls++;
      return { content: `${value}:${this.#calls}`, isError: false };
    }
  }
  for (const registration of ["open", "register"]) {
    const tool = new StatefulTool();
    let calls = 0;
    const { client, contexts } = model(async () => ++calls === 1
      ? fauxAssistantMessage(fauxToolCall("stateful", { value: "original argument" }), { stopReason: "toolUse" })
      : fauxAssistantMessage(fauxText("done")));
    const opening = ThreadRuntime.open({ ...values, model: client, tools: registration === "open" ? [tool] : [] });
    let runtime: ThreadRuntime;
    if (registration === "register") {
      runtime = await opening;
      runtime.registerTool(tool);
    }
    tool.description = "CHANGED";
    (tool.parameters.properties.value as { type: string }).type = "number";
    runtime = await opening;
    try {
      assert.equal((await runtime.prompt(runtime.initialSessionId, "use stateful tool")).outcome, "completed");
      assert.equal(tool.calls, 1);
      const advertised = contexts[0]!.tools![0]!;
      assert.equal(advertised.description, "Original description");
      assert.equal(advertised.parameters.properties.value.type, "string");
      const result = contexts[1]!.messages.find((message) => message.role === "toolResult");
      assert.ok(result && !result.isError);
      assert.match(JSON.stringify(result), /original argument:1/);
    } finally { await runtime.close(); }
  }
});

test("declared skill paths merge in order, load bodies through skill, and expose detached snapshots", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const primary = path.join(values.rootPath, "skills");
  const shared = path.join(values.directory, "shared-skills");
  await skill(primary, "guide", "PRIMARY_BODY");
  await skill(primary, "manual", "MANUAL_BODY", true);
  await skill(shared, "guide", "SHADOWED_BODY");
  await skill(shared, "shared", "SHARED_BODY");
  const paths = ["./skills", shared, primary];
  const selectedTools: Array<BuiltinToolName | AgentTool> = ["read"];
  let calls = 0;
  const { client, contexts } = model(async () => ++calls === 1
    ? fauxAssistantMessage(fauxToolCall("skill", { name: "guide" }, { id: "load-guide" }), { stopReason: "toolUse" })
    : fauxAssistantMessage(fauxText("done")));
  const systemPrompt = "Host role only.\n";
  const options: ThreadRuntimeOptions = { ...values, model: client, tools: selectedTools, skills: { paths }, systemPrompt };
  const opening = ThreadRuntime.open(options);
  paths.splice(0, paths.length, "./does-not-exist");
  selectedTools.push("write");
  options.systemPrompt = "MUTATED_PROMPT";
  const runtime = await opening;
  try {
    assert.deepEqual(runtime.skills.map((item) => item.name), ["guide", "manual", "shared"]);
    assert.equal(runtime.skills[0]?.filePath, path.join(primary, "guide", "SKILL.md"));
    assert.equal(runtime.skillDiagnostics.length, 1);
    assert.equal(runtime.skillDiagnostics[0]?.kind, "collision");
    const snapshots = runtime.skills;
    snapshots[0]!.content = "MUTATED_BODY";
    snapshots[0]!.disableModelInvocation = true;
    snapshots.length = 0;
    runtime.skillDiagnostics[0]!.message = "MUTATED_DIAGNOSTIC";
    await writeFile(path.join(primary, "guide", "SKILL.md"), "changed on disk after open");
    assert.equal((await runtime.prompt(runtime.initialSessionId, "use guide")).outcome, "completed");
    const context = contexts[0]!;
    assert.deepEqual(context.tools?.map((tool) => tool.name), ["read", "skill"]);
    assert.ok(context.systemPrompt?.startsWith(`${systemPrompt}\n\n## Skills`));
    assert.match(context.systemPrompt!, /<name>guide<\/name>/);
    assert.match(context.systemPrompt!, /<name>shared<\/name>/);
    assert.doesNotMatch(context.systemPrompt!, /manual|PRIMARY_BODY|SHADOWED_BODY|MUTATED|commit attribution|\/rewind/);
    const loaded = contexts[1]!.messages.find((message) => message.role === "toolResult");
    assert.ok(loaded && !loaded.isError);
    assert.match(JSON.stringify(loaded), /PRIMARY_BODY/);
    assert.doesNotMatch(JSON.stringify(loaded), /SHADOWED_BODY|MUTATED_BODY/);
    assert.notEqual(runtime.skillDiagnostics[0]?.message, "MUTATED_DIAGNOSTIC");
    await runtime.invokeSkill(runtime.initialSessionId, "manual", "Extra host instructions");
    const invoked = contexts.at(-1)!.messages.at(-1);
    assert.match(JSON.stringify(invoked), /MANUAL_BODY/);
    assert.match(JSON.stringify(invoked), /Extra host instructions/);
  } finally { await runtime.close(); }
});

test("manual-only and empty skill configurations add no model tool or catalog", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  const primary = path.join(values.rootPath, "skills");
  await skill(primary, "manual", "MANUAL_ONLY", true);
  for (const paths of [[], ["./missing"], ["./skills"]]) {
    const { client, contexts } = model();
    const runtime = await ThreadRuntime.open({ ...values, model: client, skills: { paths }, systemPrompt: "Host" });
    try {
      await runtime.prompt(runtime.initialSessionId, "hello");
      assert.deepEqual(contexts[0]?.tools, []);
      assert.equal(contexts[0]?.systemPrompt, "Host");
      if (paths[0] === "./skills") {
        await runtime.invokeSkill(runtime.initialSessionId, "manual");
        assert.match(JSON.stringify(contexts.at(-1)?.messages.at(-1)), /MANUAL_ONLY/);
      }
    } finally { await runtime.close(); }
  }
});

test("enabling skills rejects a host tool named skill instead of replacing it", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);
  await skill(path.join(values.rootPath, "skills"), "guide", "Instructions");
  await assert.rejects(ThreadRuntime.open({ ...values, skills: { paths: ["./skills"] }, tools: [customTool("skill")] }),
    /already registered: skill/);
  const runtime = await ThreadRuntime.open(values);
  await runtime.close();
});
