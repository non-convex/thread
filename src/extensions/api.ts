import type { CommandRegistry, ThreadCommand } from "../commands/types.js";
import type { AgentTool } from "../tools/types.js";
import type { ExtensionEventMap, ExtensionEventType, ExtensionHandler } from "./events.js";

export interface ExtensionAPI {
  registerTool(tool: AgentTool): () => void;
  registerCommand(command: ThreadCommand): () => void;
  on<K extends ExtensionEventType>(type: K, handler: ExtensionHandler<K>): () => void;
}

export function createExtensionAPI(
  runtime: Pick<ExtensionAPI, "registerTool" | "on">,
  commands: CommandRegistry,
): ExtensionAPI {
  return {
    registerTool: (tool) => runtime.registerTool(tool),
    registerCommand: (command) => commands.register(command),
    on: <K extends ExtensionEventType>(type: K, handler: ExtensionHandler<K>) => runtime.on(type, handler),
  };
}

export type { ExtensionEventMap };
