import type { CacheRetention, ModelThinkingLevel } from "@earendil-works/pi-ai";
import path from "node:path";
import type { ModelCatalog, ModelClient } from "../agent/model-client.js";
import type { AgentProfileDiagnostic } from "../agent/profile.js";
import type { RunTurnOptions } from "../agent/turn-runner.js";
import type { ImplementationWorkerProfileSettings } from "../agent-task/profile.js";
import type { ModelSelectionConfig } from "../config/thread-config.js";
import type { ThreadState } from "../config/thread-state.js";
import type { SessionRecallOptions } from "../session-recall/service.js";
import type { LoadedSkills, SkillPaths } from "../skills/loader.js";
import { builtinTool, type BuiltinToolName } from "../tools/builtins.js";
import { validateToolExecutionPolicy } from "../tools/execution.js";
import type { AgentTool } from "../tools/types.js";
import type { AskPresenter } from "./interaction.js";
import type { HostToolPolicy } from "./policy.js";

export interface ThreadRuntimeOptions {
  rootPath: string;
  /** Exact project data directory. Omitted: Thread's usual per-project directory. */
  stateDirectory?: string;
  model?: ModelClient;
  modelCatalog?: ModelCatalog;
  thinkingLevel?: ModelThinkingLevel;
  /** Base instructions. A bare runtime adds no coding or global-memory defaults. */
  systemPrompt?: string;
  appendSystemPrompt?: string;
  /** Host-provided instructions shared by the main agent and implementation workers. No file discovery. */
  sharedInstructions?: string;
  /** Selected basic tools and host tools. Omitted: no basic tools. */
  tools?: readonly (BuiltinToolName | AgentTool)[];
  cacheRetention?: CacheRetention;
  /** Only declared paths are scanned; loaded skills can also be supplied directly. */
  skills?: SkillPaths | LoadedSkills;
  /** Capture supported file edits for rewind. Default: false; sessions still persist. */
  fileCheckpoints?: boolean;
  /** Explicitly enables the recall service and its two tools. */
  search?: SessionRecallOptions;
  /** Explicitly enables global memory, using this file only. */
  globalMemoryPath?: string;
  askPresenter?: AskPresenter;
  toolPolicy?: HostToolPolicy;
  writableExternalPaths?: readonly string[];
  implementationWorker?: {
    enabled: boolean;
    model?: ModelClient;
    defaultModel?: ModelSelectionConfig;
    settings?: ImplementationWorkerProfileSettings;
  };
  dreamer?: {
    enabled: boolean;
    model?: ModelClient;
    defaultModel?: ModelSelectionConfig;
    thinkingLevel?: ModelThinkingLevel;
  };
  agentProfileDiagnostics?: readonly AgentProfileDiagnostic[];
  state?: ThreadState;
  onStateChange?: (state: ThreadState) => void;
}

export type PromptOptions = Omit<RunTurnOptions, "signal" | "sessionId"> & { signal?: AbortSignal };

export interface RewindOptions {
  signal?: AbortSignal;
  /** Default: the runtime's fileCheckpoints setting. False only moves the session's live tip. */
  restoreFiles?: boolean;
}

export type RuntimeOptionsSnapshot = Omit<ThreadRuntimeOptions, "tools"> & { tools: readonly AgentTool[] };

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
export function snapshotRuntimeOptions(options: ThreadRuntimeOptions): RuntimeOptionsSnapshot {
  return {
    ...options,
    rootPath: path.resolve(options.rootPath),
    ...(options.stateDirectory ? { stateDirectory: path.resolve(options.stateDirectory) } : {}),
    ...(options.globalMemoryPath ? { globalMemoryPath: path.resolve(options.globalMemoryPath) } : {}),
    tools: (options.tools ?? []).map((selection) => {
      const tool = typeof selection === "string" ? builtinTool(selection) : selection;
      return snapshotTool(tool);
    }),
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
