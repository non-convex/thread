import assert from "node:assert/strict";
import { mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Type, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ThreadRuntime, type AgentTool, type HostToolCall, type ToolPlanningContext } from "../src/runtime.js";
import { fixture, ScriptedModel, deferred } from "./fixtures/runtime.js";

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const comparable = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;

test("file tools authorize, schedule and execute the same normalized paths", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  await writeFile(path.join(f.rootPath, " note.txt"), "untouched spaced filename");
  await writeFile(path.join(f.rootPath, "note.txt"), "before");
  const policies: HostToolCall[] = [];
  const model = new ScriptedModel(async (_context, _options, step) => step === 1
    ? fauxAssistantMessage([
      fauxToolCall("read", { path: " note.txt " }),
      fauxToolCall("write", { path: " note.txt", content: "after write" }),
      fauxToolCall("edit", { path: "note.txt ", oldText: "after write", newText: "after edit" }),
    ], { stopReason: "toolUse" }) : fauxAssistantMessage(fauxText("done")));
  const runtime = await ThreadRuntime.open({ ...f, model, tools: ["read", "write", "edit"], toolPolicy: (event) => {
    policies.push(structuredClone({ ...event, signal: undefined }) as unknown as HostToolCall);
    assert.equal(event.args.path, "note.txt");
    assert.equal(event.resources[0]?.resource, comparable(path.join(f.rootPath, "note.txt")));
    // Neither policy nor resource-declaration mutations may rewrite the prepared call.
    (event.args as Record<string, unknown>).path = "wrong.txt";
    (event.resources[0] as { resource: string }).resource = "wrong.txt";
    return { allow: true };
  } });
  try {
    const result = await runtime.prompt(runtime.initialSessionId, "edit the note");
    assert.equal(result.outcome, "completed");
    assert.equal(policies.length, 3);
    assert.equal(await readFile(path.join(f.rootPath, "note.txt"), "utf8"), "after edit");
    assert.equal(await readFile(path.join(f.rootPath, " note.txt"), "utf8"), "untouched spaced filename");
    const snapshot = runtime.readSession(runtime.initialSessionId);
    const executions = snapshot.entries.filter((entry) => entry.type === "tool_execution");
    assert.equal(executions.length, 3);
    for (const entry of executions) assert.equal(entry.effectiveArgs.path, "note.txt");
    assert.match(JSON.stringify(snapshot.entries), /before/);
  } finally { await runtime.close(); }
});

test("grep exposes effective cursor scope and can be denied without decoding it in host policy", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const outside = path.join(f.directory, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "search.txt"), "MATCH_ONE\nMATCH_TWO\n");
  const policies: HostToolCall[] = [];
  let finalContext = "";
  const runtime = await ThreadRuntime.open({ ...f, tools: ["grep"],
    model: new ScriptedModel(async (context, _options, step) => {
      if (step === 1) return call("grep", { pattern: "MATCH", path: "../outside", limit: 1 });
      const result = context.messages.findLast((message) => message.role === "toolResult");
      if (step === 2) {
        const cursor = (result?.details as { raw: { details: { nextCursor: string } } }).raw.details.nextCursor;
        assert.ok(cursor);
        return call("grep", { pattern: "MATCH", cursor, limit: 1 });
      }
      finalContext = JSON.stringify(result);
      return fauxAssistantMessage(fauxText("done"));
    }),
    toolPolicy: (event) => {
      policies.push(event);
      return policies.length === 1 ? { allow: true } : { allow: false, reason: "Outside scope denied" };
    },
  });
  try {
    assert.equal((await runtime.prompt(runtime.initialSessionId, "search")).outcome, "completed");
    assert.equal(policies.length, 2);
    for (const policy of policies) {
      assert.equal(policy.args.path, outside);
      assert.equal(policy.resources[0]?.resource, comparable(outside));
      assert.equal(policy.resources[0]?.scope, "subtree");
    }
    assert.equal(policies[1]!.args.offset, 1);
    assert.equal("cursor" in policies[1]!.args, false);
    assert.match(finalContext, /Outside scope denied/);
    assert.doesNotMatch(finalContext, /MATCH_TWO/);
  } finally { await runtime.close(); }
});

for (const replaceTarget of [false, true]) {
  test(`path preparation pins aliases and rechecks the approved target (replace target: ${replaceTarget})`, async (t) => {
    const f = await fixture(); t.after(f.cleanup);
    const allowed = path.join(f.rootPath, "allowed"), alias = path.join(f.rootPath, "alias");
    const outside = path.join(f.directory, "outside");
    await mkdir(allowed); await mkdir(outside);
    await writeFile(path.join(allowed, "note.txt"), "approved content");
    await writeFile(path.join(outside, "note.txt"), "private content");
    await symlink(allowed, alias, process.platform === "win32" ? "junction" : "dir");
    let output = "";
    const runtime = await ThreadRuntime.open({ ...f, tools: ["read"],
      model: new ScriptedModel(async (context, _options, step) => {
        if (step === 1) return call("read", { path: "alias/note.txt" });
        output = JSON.stringify(context.messages.findLast((message) => message.role === "toolResult"));
        return fauxAssistantMessage(fauxText("done"));
      }),
      toolPolicy: async (event) => {
        assert.equal(event.resources[0]?.resource, comparable(path.join(allowed, "note.txt")));
        if (replaceTarget) {
          const moved = path.join(f.rootPath, "original");
          assert.equal(path.dirname(allowed), f.rootPath); assert.equal(path.dirname(moved), f.rootPath);
          await rename(allowed, moved);
          await symlink(outside, allowed, process.platform === "win32" ? "junction" : "dir");
        } else {
          await unlink(alias);
          await symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
        }
        return { allow: true };
      },
    });
    try {
      assert.equal((await runtime.prompt(runtime.initialSessionId, "read alias")).outcome, "completed");
      assert.doesNotMatch(output, /private content/);
      assert.match(output, replaceTarget ? /outside the approved resources/ : /approved content/);
    } finally { await runtime.close(); }
  });
}

test("host tools prepare once after extensions and preserve method binding and immutable planning data", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const order: string[] = [];
  class CustomTool implements AgentTool<{ value: string }, { value: string; prepared: boolean }> {
    name = "custom"; description = "custom preparation"; replay = "safe" as const;
    parameters = Type.Object({ value: Type.String() });
    prefix = "prepared:";
    execution = { effect: "read" as const, mode: "parallel" as const, resources(args: { value: string; prepared: boolean }) {
      order.push("resources"); assert.equal(args.value, "prepared:rewritten"); args.value = "mutated"; return [];
    } };
    prepare(args: { value: string }) { order.push("prepare"); return { value: this.prefix + args.value.trim(), prepared: true }; }
    async execute(args: { value: string; prepared: boolean }) {
      order.push("execute"); assert.equal(args.value, "prepared:rewritten"); return { content: args.value, isError: false };
    }
  }
  const runtime = await ThreadRuntime.open({ ...f, tools: [new CustomTool()],
    model: new ScriptedModel(async (_context, _options, step) => step === 1 ? call("custom", { value: "original" }) : fauxAssistantMessage(fauxText("done"))),
    toolPolicy: (event) => { order.push("policy"); assert.equal(event.args.prepared, true); assert.equal(event.args.value, "prepared:rewritten"); return { allow: true }; },
  });
  runtime.on("before_tool_call", (event) => { order.push("extension"); return { ...event, args: { value: " rewritten " } }; });
  try {
    await runtime.prompt(runtime.initialSessionId, "prepare");
    assert.deepEqual(order, ["extension", "prepare", "resources", "policy", "execute"]);
  } finally { await runtime.close(); }
});

test("cancellation during preparation prevents authorization and execution", async (t) => {
  const f = await fixture(); t.after(f.cleanup);
  const started = deferred();
  let effects = 0, policies = 0;
  const tool: AgentTool = {
    name: "pause", description: "cancel preparation", replay: "safe", parameters: Type.Object({}),
    async prepare(args, context: ToolPlanningContext) {
      started.resolve();
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
      context.signal.throwIfAborted(); return args;
    },
    execution: { effect: "read", mode: "parallel", resources: () => [] },
    async execute() { effects++; return { content: "unexpected", isError: false }; },
  };
  const runtime = await ThreadRuntime.open({ ...f, tools: [tool], model: new ScriptedModel(async () => call("pause", {})),
    toolPolicy: () => { policies++; return { allow: true }; },
  });
  const operation = runtime.prompt(runtime.initialSessionId, "cancel");
  try {
    await Promise.race([started.promise, operation.then(() => { throw new Error("Turn ended early"); })]);
    await runtime.interrupt(runtime.initialSessionId);
    assert.equal((await operation).outcome, "interrupted");
    assert.equal(policies, 0); assert.equal(effects, 0);
  } finally { await runtime.close(); await operation; }
});
