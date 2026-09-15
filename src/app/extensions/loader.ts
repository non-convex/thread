import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "./api.js";

export type ExtensionDisposer = () => void | Promise<void>;
export type ExtensionActivator = (api: ExtensionAPI) => void | ExtensionDisposer | Promise<void | ExtensionDisposer>;

export async function loadExtension(specifier: string, api: ExtensionAPI, rootPath: string): Promise<void | ExtensionDisposer> {
  const resolved = specifier.startsWith(".") || path.isAbsolute(specifier)
    ? pathToFileURL(path.resolve(rootPath, specifier)).href
    : specifier;
  const module = (await import(resolved)) as {
    default?: ExtensionActivator;
    activate?: ExtensionActivator;
  };
  const activate = module.activate ?? module.default;
  if (typeof activate !== "function") throw new Error(`Extension ${specifier} does not export activate() or default`);
  const dispose = await activate(api);
  if (dispose !== undefined && typeof dispose !== "function") throw new Error(`Extension ${specifier} returned an invalid cleanup function`);
  return dispose;
}
