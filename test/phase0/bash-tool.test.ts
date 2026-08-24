import assert from "node:assert/strict";
import test from "node:test";
import { registerBuiltinTools } from "../../src/tools/builtins.js";
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

  const okCommand = process.platform === "win32" ? "Write-Output '你好'" : "printf '你好'";
  const succeeded = await bash.execute({ command: okCommand }, context);
  assert.equal(succeeded.isError, false);
  assert.match(succeeded.content, /你好/);
});
