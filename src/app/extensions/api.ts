import type { ThreadRuntime } from "../../core/runtime/thread-runtime.js";
import type { CommandRegistry, ThreadCommand } from "../commands/types.js";
import type { AgentTool } from "../../core/tools/types.js";
import type { ExtensionEventMap, ExtensionEventType, ExtensionHandler } from "../../core/extensions/events.js";

export interface ExtensionAPI extends Pick<ThreadRuntime, "subscribe" | "listSessions" | "readSession" | "readHistory" | "agentTaskDetailsForTurn"> {
  registerTool(tool: AgentTool): () => void;
  registerCommand(command: ThreadCommand): () => void;
  on<K extends ExtensionEventType>(type: K, handler: ExtensionHandler<K>): () => void;
}

export function createExtensionAPI(
  runtime: ThreadRuntime,
  commands: CommandRegistry,
): ExtensionAPI {
  return {
    subscribe: (listener, options) => runtime.subscribe(listener, options),
    listSessions: () => runtime.listSessions(),
    readSession: (sessionId) => runtime.readSession(sessionId),
    readHistory: () => runtime.readHistory(),
    agentTaskDetailsForTurn: (turnId) => runtime.agentTaskDetailsForTurn(turnId),
    registerTool: (tool) => runtime.registerTool(tool),
    registerCommand: (command) => commands.register(command),
    on: <K extends ExtensionEventType>(type: K, handler: ExtensionHandler<K>) => runtime.on(type, handler),
  };
}

export type { ExtensionEventMap };
