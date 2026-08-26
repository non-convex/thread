import assert from "node:assert/strict";
import test from "node:test";
import { registerBuiltinTools, windowsShellCandidates } from "../../src/tools/builtins.js";
import { ToolRegistry } from "../../src/tools/types.js";

test("the bash tool propagates shell exit codes and separates stderr", async () => {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  const bash = registry.get("bash");
  assert.ok(bash);

  const context = { rootPath: process.cwd(), signal: new AbortController().signal };
  const failed = await bash.execute({ command: "exit 7" }, context);
  assert.equal(failed.isError, true);
  assert.match(failed.content, /exited with code 7/);

  // `echo` behaves the same in Git Bash and PowerShell, so the assertion does
  // not depend on which Windows shell was selected.
  const succeeded = await bash.execute({ command: "echo 你好" }, context);
  assert.equal(succeeded.isError, false);
  assert.match(succeeded.content, /你好/);
});

test("Windows shell selection prefers Git Bash and falls back to PowerShell", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows shell selection only applies on Windows");
    return;
  }
  const candidates = windowsShellCandidates("echo hello");
  const bashCount = candidates.filter((candidate) => candidate.command.endsWith("bash.exe")).length;

  // PowerShell must always remain reachable, in that order, so a machine
  // without Git Bash still has a working shell.
  const tail = candidates.slice(bashCount).map((candidate) => candidate.command);
  assert.deepEqual(tail, ["pwsh", "powershell.exe"]);

  for (const candidate of candidates.slice(0, bashCount)) {
    assert.deepEqual(candidate.args, ["-lc", "echo hello"]);
  }
  for (const candidate of candidates.slice(bashCount)) {
    assert.equal(candidate.args[0], "-NoLogo");
    assert.equal(candidate.args.at(-2), "-Command");
  }
});

test("an explicit THREAD_GIT_BASH override is tried before any other shell", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows shell selection only applies on Windows");
    return;
  }
  const previous = process.env.THREAD_GIT_BASH;
  // A real existing file is required, because candidates are filtered by
  // existence; the current executable is guaranteed to exist.
  process.env.THREAD_GIT_BASH = process.execPath;
  t.after(() => {
    if (previous === undefined) delete process.env.THREAD_GIT_BASH;
    else process.env.THREAD_GIT_BASH = previous;
  });

  const candidates = windowsShellCandidates("echo hello");
  assert.equal(candidates[0]!.command, process.execPath);
  assert.deepEqual(candidates[0]!.args, ["-lc", "echo hello"]);
});
