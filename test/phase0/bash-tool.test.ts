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

  // `echo` behaves the same in Git Bash and PowerShell, so this does not depend
  // on which Windows shell was selected.
  const succeeded = await bash.execute({ command: "echo 你好" }, context);
  assert.equal(succeeded.isError, false);
  assert.match(succeeded.content, /你好/);
});

test("Windows shell selection puts Git Bash before the PowerShell fallbacks", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows shell selection only applies on Windows");
    return;
  }
  const previous = process.env.THREAD_GIT_BASH;
  // Candidates are filtered by existence, so the override needs a real file.
  process.env.THREAD_GIT_BASH = process.execPath;
  t.after(() => {
    if (previous === undefined) delete process.env.THREAD_GIT_BASH;
    else process.env.THREAD_GIT_BASH = previous;
  });

  const candidates = windowsShellCandidates("echo hello");
  assert.deepEqual(candidates[0], { command: process.execPath, args: ["-lc", "echo hello"] });
  assert.deepEqual(
    candidates.filter((candidate) => !candidate.command.endsWith("bash.exe") && candidate.command !== process.execPath)
      .map((candidate) => candidate.command),
    ["pwsh", "powershell.exe"],
  );
});
