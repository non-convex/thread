import type { CommandRegistry, ThreadCommand } from "../commands/types.js";
import type { AgentTool, ToolRegistry } from "../tools/types.js";
import type { ExtensionEventMap, ExtensionEventType, ExtensionHandler, ExtensionEvents } from "./events.js";

export interface ExtensionAPI {
  registerTool(tool: AgentTool): () => void;
  registerCommand(command: ThreadCommand): () => void;
  on<K extends ExtensionEventType>(type: K, handler: ExtensionHandler<K>): () => void;
}

export function createExtensionAPI(
  tools: ToolRegistry,
  commands: CommandRegistry,
  events: ExtensionEvents,
): ExtensionAPI {
  return {
    registerTool: (tool) => tools.register(tool),
    registerCommand: (command) => commands.register(command),
    on: <K extends ExtensionEventType>(type: K, handler: ExtensionHandler<K>) => events.on(type, handler),
  };
}

export type { ExtensionEventMap };
