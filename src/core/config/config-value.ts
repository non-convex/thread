import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const commandCache = new Map<string, Promise<string | undefined>>();
const ENV_NAME_START = /[A-Za-z_]/;
const ENV_NAME_PART = /[A-Za-z0-9_]/;

async function executeCommand(config: string): Promise<string | undefined> {
  let pending = commandCache.get(config);
  if (!pending) {
    pending = execAsync(config.slice(1), { timeout: 10_000, windowsHide: true })
      .then(({ stdout }) => stdout.trim() || undefined)
      .catch(() => undefined);
    commandCache.set(config, pending);
  }
  return pending;
}

export async function resolveConfigValue(
  config: string,
  env: (name: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  if (config.startsWith("!")) return executeCommand(config);
  let output = "";
  for (let index = 0; index < config.length; index++) {
    const character = config[index]!;
    if (character !== "$") {
      output += character;
      continue;
    }
    const next = config[index + 1];
    if (next === "$" || next === "!") {
      output += next;
      index++;
      continue;
    }
    let name = "";
    if (next === "{") {
      const end = config.indexOf("}", index + 2);
      if (end < 0) {
        output += "$";
        continue;
      }
      name = config.slice(index + 2, end);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        output += config.slice(index, end + 1);
        index = end;
        continue;
      }
      index = end;
    } else if (next && ENV_NAME_START.test(next)) {
      let end = index + 2;
      while (end < config.length && ENV_NAME_PART.test(config[end]!)) end++;
      name = config.slice(index + 1, end);
      index = end - 1;
    } else {
      output += "$";
      continue;
    }
    const value = await env(name);
    if (value === undefined) return undefined;
    output += value;
  }
  return output;
}

export async function resolveConfigHeaders(
  headers: Record<string, string> | undefined,
  env: (name: string) => Promise<string | undefined>,
): Promise<Record<string, string> | undefined> {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [name, config] of Object.entries(headers)) {
    const value = await resolveConfigValue(config, env);
    if (value === undefined) return undefined;
    resolved[name] = value;
  }
  return resolved;
}
