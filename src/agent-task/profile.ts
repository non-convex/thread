import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelClient } from "../agent/model-client.js";
import type { AgentProfile } from "../agent/profile.js";
import { registerImplementationWorkerTools } from "../tools/builtins.js";
import { ToolRegistry } from "../tools/types.js";
import { IMPLEMENTATION_WORKER_SYSTEM_PROMPT } from "./prompt.js";

// Kept as a source-level compatibility export while the shared profile moves
// out of the implementation-task subsystem.
export { AgentProfileRegistry } from "../agent/profile.js";

export const IMPLEMENTATION_WORKER_PROFILE_ID = "implementation-worker";

export interface ImplementationWorkerProfileSettings {
  thinkingLevel: ModelThinkingLevel;
  limits: ImplementationWorkerLimits;
}

export interface ImplementationWorkerLimits {
  maxConcurrent: number;
  maxSteps: number;
  maxRuntimeMs: number;
  maxRevisions: number;
}

export const DEFAULT_IMPLEMENTATION_WORKER_SETTINGS: ImplementationWorkerProfileSettings = {
  thinkingLevel: "xhigh",
  limits: {
    maxConcurrent: 2,
    maxSteps: 100,
    maxRuntimeMs: 60 * 60_000,
    maxRevisions: 2,
  },
};

function resolveWorkerThinkingLevel(
  model: ModelClient,
  requested: ModelThinkingLevel,
): ModelThinkingLevel {
  if (!model.reasoning) return "off";
  if (requested !== "xhigh") return requested;
  const supported = model.supportedThinkingLevels;
  return supported?.length && !supported.includes("xhigh") ? "high" : "xhigh";
}

export function createImplementationWorkerProfile(
  model: ModelClient,
  settings: ImplementationWorkerProfileSettings = DEFAULT_IMPLEMENTATION_WORKER_SETTINGS,
): AgentProfile {
  const tools = new ToolRegistry();
  registerImplementationWorkerTools(tools);
  return {
    id: IMPLEMENTATION_WORKER_PROFILE_ID,
    model,
    thinkingLevel: resolveWorkerThinkingLevel(model, settings.thinkingLevel),
    tools,
    systemPrompt: IMPLEMENTATION_WORKER_SYSTEM_PROMPT,
  };
}
