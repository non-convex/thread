import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "./api.js";

export type ExtensionActivator = (api: ExtensionAPI) => void | Promise<void>;

export async function loadExtension(specifier: string, api: ExtensionAPI, rootPath: string): Promise<void> {
  const resolved = specifier.startsWith(".") || path.isAbsolute(specifier)
    ? pathToFileURL(path.resolve(rootPath, specifier)).href
    : specifier;
  const module = (await import(resolved)) as {
    default?: ExtensionActivator;
    activate?: ExtensionActivator;
  };
  const activate = module.activate ?? module.default;
  if (typeof activate !== "function") throw new Error(`Extension ${specifier} does not export activate() or default`);
  await activate(api);
}
