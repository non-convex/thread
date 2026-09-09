import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dir, "..");
const dist = path.join(root, "dist");
const transpiler = new Bun.Transpiler({ loader: "js" });
const checked = new Set<string>();

async function assertHeadlessImportGraph(file: string): Promise<void> {
  if (checked.has(file)) return;
  checked.add(file);
  const bundle = await readFile(file, "utf8");
  for (const imported of transpiler.scanImports(bundle)) {
    assert.doesNotMatch(imported.path, /^(?:@opentui\/|solid-js(?:\/|$))/, `${file} imports the terminal frontend`);
    if ((imported.kind === "import-statement" || imported.kind === "require-call") && imported.path.startsWith(".")) {
      const dependency = path.resolve(path.dirname(file), imported.path);
      assert.ok(dependency.startsWith(`${dist}${path.sep}`), `Bundle import leaves dist: ${dependency}`);
      await assertHeadlessImportGraph(dependency);
    }
  }
}

for (const entry of ["index.js", "runtime.js"]) {
  await assertHeadlessImportGraph(path.join(dist, entry));
}

async function assertCoreDependencyDirection(file: string): Promise<void> {
  const source = ts.preProcessFile(await readFile(file, "utf8"), true, true);
  for (const imported of source.importedFiles) {
    const specifier = imported.fileName;
    assert.doesNotMatch(specifier, /^(?:@opentui\/|solid-js(?:\/|$)|thread(?:\/|$))/, `${file} imports a frontend or package entry`);
    if (!specifier.startsWith(".")) continue;
    const dependency = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts"));
    const relative = path.relative(path.join(root, "src"), dependency).replaceAll("\\", "/");
    assert.match(relative, /^core\//, `${file} imports outside src/core: ${relative}`);
    await access(dependency);
  }
}
await assertCoreDependencyDirection(path.join(root, "src", "runtime.ts"));
// Include type imports and modules reached only by workers or standalone builds.
for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: path.join(root, "src", "core"), absolute: true })) {
  await assertCoreDependencyDirection(file);
}

// An independent host resolves the package's published exports. Running outside
// the repository also prevents its TUI preload from concealing an import leak.
const host = await mkdtemp(path.join(tmpdir(), "thread-runtime-host-"));
const links: string[] = [];
try {
  const modules = path.join(host, "node_modules");
  await mkdir(path.join(modules, "@earendil-works"), { recursive: true });
  for (const [target, link] of [
    [root, path.join(modules, "thread")],
    [path.join(root, "node_modules", "@earendil-works", "pi-ai"), path.join(modules, "@earendil-works", "pi-ai")],
  ] as const) {
    await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    links.push(link);
  }
  const config = path.join(host, "bunfig.toml");
  await writeFile(config, "# Independent headless host; no preload hooks.\n", "utf8");
  const built = await Bun.build({
    entrypoints: [path.join(root, "examples", "runtime.ts")],
    outdir: host,
    naming: "example.mjs",
    target: "bun",
    format: "esm",
    packages: "external",
  });
  assert.equal(built.success, true, built.logs.map(String).join("\n"));
  const check = path.join(host, "check.mjs");
  await writeFile(check, `import assert from "node:assert/strict";
import * as thread from "thread";
import * as runtime from "thread/runtime";
for (const name of ["ThreadRuntime", "RuntimeLimitError", "AskService", "AskDismissedError"]) {
  assert.equal(typeof thread[name], "function", name);
  assert.strictEqual(thread[name], runtime[name], name + " differs between public entries");
}
assert.equal(thread.ThreadApp.prototype instanceof runtime.ThreadRuntime, false);
assert.equal("createCodingRuntime" in runtime, false);
assert.equal("createCodingRuntime" in thread, false);
await import("./example.mjs");
console.log("Public entries share runtime and error constructors.");
`, "utf8");
  const defaultHome = path.join(host, "unused-default-home");
  const child = Bun.spawn([process.execPath, `--config=${config}`, check], {
    cwd: host,
    env: { ...process.env, THREAD_HOME: defaultHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 30_000);
  let stdout: string;
  let stderr: string;
  let code: number;
  try {
    [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
  } finally {
    clearTimeout(timeout);
  }
  assert.equal(code, 0, `Embedding example failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /The answer is 42\./);
  assert.match(stdout, /Turn: completed;/);
  assert.match(stdout, /Selected builtin, custom tool, and declared Skill path verified\./);
  assert.match(stdout, /Public entries share runtime and error constructors\./);
  await assert.rejects(access(defaultHome), { code: "ENOENT" });
  process.stdout.write(stdout);
  console.log("Runtime export and independent host smoke checks passed.");
} finally {
  // Remove the package junctions explicitly before removing the temporary host.
  for (const link of links) await unlink(link);
  assert.equal(path.dirname(host), path.resolve(tmpdir()));
  await rm(host, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
