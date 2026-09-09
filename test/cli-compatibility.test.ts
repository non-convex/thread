import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_COMMIT_ATTRIBUTION } from "../src/app/system-prompt.js";
import { FILE_EDITING_PROMPT } from "../src/core/tools/file-editing-prompt.js";
import { GLOBAL_MEMORY_FILE } from "../src/core/global-memory.js";

interface RequestBody {
  model: string;
  messages: Array<{ role: string; content: string }>;
  tools: Array<{ function: { name: string } }>;
}

// Exercise the actual CLI and provider adapter, with only the HTTP model replaced.
// This catches missing product defaults that manually configured app fixtures cannot.
test("real CLI preserves coding defaults, extension tools, file rewind, menus and resumed preferences", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-cli-compatibility-"));
  const rootPath = path.join(directory, "project");
  const home = path.join(directory, "home");
  const skillPath = path.join(home, "skills", "compatibility");
  await mkdir(rootPath);
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, "SKILL.md"), "---\nname: compatibility\ndescription: Check the coding application.\n---\nFollow the fixture instructions.\n");
  await writeFile(path.join(home, GLOBAL_MEMORY_FILE), "CLI_MEMORY_MARKER");
  await writeFile(path.join(rootPath, "fixture.txt"), "original bytes\r\n");
  await writeFile(path.join(rootPath, "AGENTS.md"), "CLI_PROJECT_RULES_MARKER");
  const requests: RequestBody[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as RequestBody;
    requests.push(body);
    const last = body.messages.at(-1)!;
    const tool = last.role === "user" && last.content === "edit fixture" ? "write"
      : last.role === "user" && last.content === "use extension" ? "host_echo"
      : last.role === "user" && last.content === "ask fixture" ? "ask" : undefined;
    const args = tool === "write" ? { path: "fixture.txt", content: "edited bytes\n" }
      : tool === "ask" ? { questions: [{ question: "Choose output", header: "Output", options: [
        { label: "Text", description: "Use text." }, { label: "JSON", description: "Use JSON." },
      ] }] } : {};
    const delta = tool
      ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }] }
      : { role: "assistant", content: "CLI_COMPAT_OK" };
    const chunk = (value: object) => `data: ${JSON.stringify({ id: "fixture-response", object: "chat.completion.chunk", created: 1, model: body.model, ...value })}\n\n`;
    return new Response(chunk({ choices: [{ index: 0, delta, finish_reason: null }] })
      + chunk({ choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })
      + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  } });
  const config = path.join(home, "config.json");
  await writeFile(config, JSON.stringify({
    search: { semantic: false }, model: { provider: "fixture", id: "configured" },
    defaultThinkingLevel: "medium",
    providers: { fixture: { api: "openai-completions", baseUrl: `${server.url}v1`, apiKey: "local-fixture-key",
      models: ["configured", "remembered"].map((id) => ({ id, name: id, reasoning: true, input: ["text", "image"], contextWindow: 128_000, maxTokens: 8192 })) } },
  }));
  await writeFile(path.join(home, "state.json"), JSON.stringify({ model: { provider: "fixture", id: "remembered" }, thinkingLevel: "high" }));
  const extension = path.join(directory, "extension.mjs");
  await writeFile(extension, `export default function (api) {
    api.registerTool({ name: "host_echo", description: "Fixture host tool", parameters: { type: "object", properties: {} }, replay: "safe",
      execution: { effect: "read", mode: "parallel", resources: () => [] },
      async execute() { return { content: "EXTENSION_TOOL_RESULT", isError: false }; } });
    api.registerCommand({ name: "fixture", description: "Fixture command", async execute(_args, context) {
      if ("tree" in context) throw new Error("Command bypasses the runtime boundary");
      return { content: "EXTENSION_COMMAND " + context.runtime.listSessions().length, presentation: "ephemeral", changedState: false };
    } });
  }`);
  let child: ChildProcessWithoutNullStreams | undefined;
  let stdout = "";
  let stderr = "";
  let exited: Promise<number | null> = Promise.resolve(0);
  async function until(check: () => boolean) {
    const deadline = Date.now() + 15_000;
    while (!check()) {
      assert.ok(child?.exitCode === null && Date.now() < deadline, `CLI stalled:\n${stdout}\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  async function start() {
    stdout = ""; stderr = "";
    child = spawn(process.execPath, [path.resolve("src/cli/main.ts"), "--root", rootPath, "--config", config, "--tui", "plain", "--extension", extension], {
      cwd: directory, windowsHide: true,
      env: { ...process.env, THREAD_HOME: home, THREAD_PROVIDER: "", THREAD_MODEL: "", PI_CODING_AGENT_DIR: path.join(directory, "empty-pi") },
    });
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    exited = new Promise((resolve, reject) => { child!.once("exit", resolve); child!.once("error", reject); });
    void exited.catch(() => undefined);
    await until(() => stdout.endsWith("> "));
  }
  async function command(input: string) {
    const offset = stdout.length;
    child!.stdin.write(`${input}\n`);
    await until(() => stdout.length > offset && stdout.endsWith("> "));
    const response = stdout.slice(offset);
    assert.doesNotMatch(response, /\[error\]|\[turn failed/);
    return response;
  }
  async function stop() {
    child!.stdin.write("/exit\n");
    const timeout = setTimeout(() => child?.kill(), 5000);
    try { assert.equal(await exited, 0, stderr); } finally { clearTimeout(timeout); }
  }
  try {
    await start();
    assert.match(stdout, /model fixture\/remembered/);
    assert.match(stdout, /implementation-worker off/);
    assert.match(stdout, /dreamer off/);
    const firstSession = /Session (session_\w+) @/.exec(stdout)![1]!;
    assert.match(await command("/skill"), /compatibility/);
    assert.ok((await command("/skill")).includes(path.join(home, "skills")));
    assert.match(await command("/agent"), /main: on.*fixture\/remembered/);
    assert.match(await command("/thread fixture"), /EXTENSION_COMMAND 1/);
    const answer = await command("edit fixture");
    assert.equal(answer.split("CLI_COMPAT_OK").length - 1, 1, "streamed answer must appear exactly once");
    assert.equal(await readFile(path.join(rootPath, "fixture.txt"), "utf8"), "edited bytes\n");
    const first = requests[0]!;
    assert.equal(first.model, "remembered");
    assert.deepEqual(first.tools.map((tool) => tool.function.name).sort(),
      ["read", "list", "grep", "write", "edit", "bash", "websearch", "webfetch", "session_search", "session_read", "skill", "ask", "host_echo"].sort());
    const instructions = first.messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => message.content).join("\n");
    assert.ok(instructions.startsWith(DEFAULT_SYSTEM_PROMPT));
    assert.ok(instructions.includes(FILE_EDITING_PROMPT));
    assert.ok(instructions.includes(DEFAULT_COMMIT_ATTRIBUTION));
    assert.match(instructions, /CLI_MEMORY_MARKER/);
    assert.match(instructions, /CLI_PROJECT_RULES_MARKER/);
    assert.match(instructions, /<name>compatibility<\/name>/);
    const projects = await readdir(path.join(home, "projects"));
    const logPath = path.join(home, "projects", projects[0]!, "session-tree", "events.jsonl");
    const events = (await readFile(logPath, "utf8")).trim().split("\n").flatMap((line) => {
      const record = JSON.parse(line);
      return record.type === "batch" ? record.events : [record];
    });
    const turn = events.find((event) => event.type === "turn_started").turn;
    assert.equal(turn.fileCheckpoints, true);
    assert.ok(events.some((event) => event.type === "entry_appended" && event.entry.type === "file_edit"));
    assert.match(await command(`/rewind ${turn.id}`), /prior path retained/);
    assert.equal(await readFile(path.join(rootPath, "fixture.txt"), "utf8"), "original bytes\r\n");
    assert.match(await command("/thread history"), /edit fixture/);
    await command("use extension");
    assert.match(JSON.stringify(requests.at(-1)), /EXTENSION_TOOL_RESULT/);
    await command("ask fixture");
    assert.match(JSON.stringify(requests.at(-1)), /No interactive user is attached/);
    assert.match(await command("/new"), /Created empty Session/);
    await command("/model fixture/configured");
    await command("new session input");
    assert.equal(requests.at(-1)!.model, "configured");
    assert.doesNotMatch(JSON.stringify(requests.at(-1)!.messages), /use extension|edit fixture/);
    await writeFile(path.join(rootPath, "fixture.txt"), "manual edit");
    assert.match(await command(`/session ${firstSession}`), /Opened Session/);
    assert.equal(await readFile(path.join(rootPath, "fixture.txt"), "utf8"), "manual edit");
    await stop();
    const preferences = JSON.parse(await readFile(path.join(home, "state.json"), "utf8"));
    assert.deepEqual(preferences.model, { provider: "fixture", id: "configured" });
    assert.equal(preferences.thinkingLevel, "high");
    await start();
    assert.ok(stdout.includes(`Session ${firstSession} @`));
    assert.match(stdout, /model fixture\/configured/);
    assert.match(await command("/thread history"), /edit fixture/);
    await stop();
  } finally {
    if (child?.exitCode === null) child.kill();
    await exited.catch(() => undefined);
    await server.stop(true);
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
