import path from "node:path";
import { builtinTool } from "../tools/builtins.js";
import { validateToolExecutionPolicy } from "../tools/execution.js";
import type { AgentTool } from "../tools/types.js";
import type { ThreadRuntimeOptions } from "./thread-runtime.js";

// Schema metadata includes non-enumerable TypeBox markers. structuredClone
// drops those; copy descriptors while retaining executable annotations.
function snapshotSchema<T>(value: T): T {
  if (Array.isArray(value)) return value.map(snapshotSchema) as T;
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy = Object.create(prototype);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if ("value" in descriptor) descriptor.value = snapshotSchema(descriptor.value);
    Object.defineProperty(copy, key, descriptor);
  }
  return copy;
}

export function snapshotTool(tool: AgentTool): AgentTool {
  validateToolExecutionPolicy(tool.execution);
  if (typeof tool.execute !== "function") throw new Error(`Tool ${tool.name} must provide execute()`);
  return {
    name: tool.name, description: tool.description, parameters: snapshotSchema(tool.parameters), replay: tool.replay,
    execution: { effect: tool.execution.effect, mode: tool.execution.mode, resources: tool.execution.resources.bind(tool.execution) },
    execute: tool.execute.bind(tool),
  };
}

/** Capture configuration before any asynchronous startup work; executable resources stay host-owned. */
export function snapshotRuntimeOptions(options: ThreadRuntimeOptions): ThreadRuntimeOptions {
  return {
    ...options,
    rootPath: path.resolve(options.rootPath),
    ...(options.stateDirectory ? { stateDirectory: path.resolve(options.stateDirectory) } : {}),
    ...(options.globalMemoryPath ? { globalMemoryPath: path.resolve(options.globalMemoryPath) } : {}),
    ...(options.tools ? { tools: options.tools.map((selection) => {
      const tool = typeof selection === "string" ? builtinTool(selection) : selection;
      return snapshotTool(tool);
    }) } : {}),
    ...(options.skills ? { skills: structuredClone(options.skills) } : {}),
    ...(options.search ? { search: { ...options.search } } : {}),
    ...(options.writableExternalPaths ? { writableExternalPaths: options.writableExternalPaths.map((item) => path.resolve(item)) } : {}),
    ...(options.state ? { state: structuredClone(options.state) } : {}),
    ...(options.agentProfileDiagnostics ? { agentProfileDiagnostics: structuredClone(options.agentProfileDiagnostics) } : {}),
    ...(options.implementationWorker ? { implementationWorker: {
      ...options.implementationWorker,
      ...(options.implementationWorker.settings ? { settings: structuredClone(options.implementationWorker.settings) } : {}),
      ...(options.implementationWorker.defaultModel ? { defaultModel: { ...options.implementationWorker.defaultModel } } : {}),
    } } : {}),
    ...(options.dreamer ? { dreamer: { ...options.dreamer,
      ...(options.dreamer.defaultModel ? { defaultModel: { ...options.dreamer.defaultModel } } : {}),
    } } : {}),
  };
}
