import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ThreadApp } from "../src/app.js";
import { MODEL_FILES, MODEL_REPO, MODEL_REVISION, prepareModel } from "../src/session-recall/model-assets.js";

const input = process.argv[2];
if (!input) throw new Error("Usage: bun scripts/smoke-recall-standalone.ts <binary>");
const canonicalModel = await prepareModel(AbortSignal.timeout(15 * 60_000));
// Deliberately outside the checkout and all of its parent node_modules directories.
const directory = await mkdtemp(path.join(tmpdir(), "thread-standalone-recall-"));
const root = path.join(directory, "中文项目");
const home = path.join(directory, "home");
const executable = path.join(directory, process.platform === "win32" ? "thread.exe" : "thread");
const config = path.join(directory, "config.json");
await mkdir(root, { recursive: true });
await copyFile(path.resolve(input), executable);
if (process.platform !== "win32") await chmod(executable, 0o755);
await writeFile(config, JSON.stringify({ search: { semantic: true } }));
const previousHome = process.env.THREAD_HOME;
let manifestPath: string;
let turnId: string;
try {
  process.env.THREAD_HOME = home;
  const seed = await ThreadApp.open({ rootPath: root, search: { semantic: false }, skills: { skills: [], diagnostics: [] } });
  try {
    const turn = await seed.sessionTree.startTurn("会话历史采用追加日志，旧记录会保留下来。文件 src/history/records.ts，错误码 E_HISTORY_271。", "ws");
    await seed.sessionTree.finishTurn(turn.id, "completed");
    turnId = turn.id;
    manifestPath = path.join(seed.project.statePath, "session-search/manifest.json");
  } finally { await seed.close(); }
} finally {
  if (previousHome === undefined) delete process.env.THREAD_HOME;
  else process.env.THREAD_HOME = previousHome;
}

let downloads = 0;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const name = new URL(request.url).pathname.replace(`/${MODEL_REPO}/resolve/${MODEL_REVISION}/`, "");
  if (!MODEL_FILES.some((file) => file.name === name)) return new Response("Not found", { status: 404 });
  downloads++;
  return new Response(Bun.file(path.join(canonicalModel, name)));
} });
const endpoint = server.url.toString().replace(/\/$/, "");
let child: ChildProcessWithoutNullStreams | undefined;
let exited: Promise<unknown> = Promise.resolve();
let output = "";
let errors = "";

async function until(predicate: () => boolean | Promise<boolean>, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (child?.exitCode !== null || Date.now() > deadline) throw new Error(`Standalone smoke stalled\n${output}\n${errors}`);
    await delay(50);
  }
}

async function start(): Promise<void> {
  output = ""; errors = "";
  child = spawn(executable, ["--root", root, "--config", config, "--tui", "plain"], {
    cwd: directory, windowsHide: true,
    env: { ...process.env, THREAD_HOME: home, HF_ENDPOINT: endpoint, PI_CODING_AGENT_DIR: path.join(directory, "empty-pi") },
  });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { errors += String(chunk); });
  exited = new Promise((resolve, reject) => { child!.once("exit", resolve); child!.once("error", reject); });
  await until(() => output.endsWith("> "));
}

async function command(query: string): Promise<string> {
  const offset = output.length;
  child!.stdin.write(`/thread search ${query}\n`);
  await until(() => output.slice(offset).includes("[thread result]") && output.endsWith("> "));
  const result = output.slice(offset);
  assert.doesNotMatch(result, /\[error\]|unavailable|literal search:/);
  return result;
}

async function stop(): Promise<void> {
  child!.stdin.write("/exit\n");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Standalone did not exit cleanly")), 10_000);
    })]);
  } finally { clearTimeout(timer); }
  assert.equal(child!.exitCode, 0, errors);
  assert.equal(errors, "");
  child = undefined;
}

try {
  await start();
  const first = await command("历史日志");
  assert.match(first, /keyword/);
  let lastStatus = Date.now();
  await until(async () => {
    if (Date.now() - lastStatus > 1_000) {
      await command("历史日志"); // Surface preparation failures instead of only waiting for progress.
      lastStatus = Date.now();
    }
    try { return Boolean(JSON.parse(await readFile(manifestPath, "utf8")).semantic[turnId]); }
    catch { return false; }
  }, 120_000);
  assert.equal(downloads, MODEL_FILES.length, "The executable must fetch its missing model files exactly once");
  server.stop(true);
  const semantic = await command("以前聊天的内容还能找回来吗");
  assert.match(semantic, /semantic: ready/);
  assert.match(semantic, /semantic\n/);
  assert.match(await command("E_HISTORY_271"), /literal/);
  await stop();
  await start();
  // No server is listening now: the binary must reuse the verified cache offline.
  let reopened = await command("历史日志");
  const deadline = Date.now() + 30_000;
  while (!reopened.includes("semantic: ready")) {
    assert.ok(Date.now() < deadline, "Cached model did not initialize offline");
    await delay(100);
    reopened = await command("历史日志");
  }
  assert.equal(downloads, MODEL_FILES.length);
  await stop();
  console.log(JSON.stringify({ platform: process.platform, architecture: process.arch, standalone: "passed",
    chinesePaths: "passed", initialDownloads: downloads, offlineRestart: "passed" }));
} finally {
  server.stop(true);
  if (child) { child.kill(); await exited.catch(() => undefined); }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
