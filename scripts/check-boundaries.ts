import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const violations: string[] = [];

function inside(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function checkFile(file: string, allowed: readonly string[]): Promise<void> {
  const source = await readFile(file, "utf8");
  for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
    const specifier = imported.fileName;
    const selfImport = specifier === "thread" || specifier.startsWith("thread/");
    const local = specifier.startsWith(".") || path.isAbsolute(specifier);
    if (!selfImport && (!local || allowed.some((directory) => inside(directory, path.resolve(path.dirname(file), specifier))))) continue;
    const line = source.slice(0, imported.pos).split("\n").length;
    violations.push(`${path.relative(root, file)}:${line}: forbidden layer import ${specifier}`);
  }
}

async function checkDirectory(directory: string, allowed: readonly string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkDirectory(file, allowed);
    else if (/\.tsx?$/.test(entry.name)) await checkFile(file, allowed);
  }
}

const core = path.join(root, "core");
const app = path.join(root, "app");
await checkDirectory(core, [core]);
await checkDirectory(app, [core, app]);
await checkFile(path.join(root, "runtime.ts"), [core]);
if (violations.length) throw new Error(`Source dependency boundaries failed:\n${violations.join("\n")}`);
console.log("Source dependency boundaries passed");
