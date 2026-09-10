import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelClient } from "../agent/model-client.js";
import type { AgentProfile } from "../agent/profile.js";
import { registerWorkerTools } from "../tools/builtins.js";
import { ToolRegistry } from "../tools/types.js";
import { workerSystemPrompt } from "./prompt.js";

export const WORKER_PROFILE_ID = "worker";

export interface WorkerProfileSettings {
  thinkingLevel: ModelThinkingLevel;
  limits: WorkerLimits;
}

export interface WorkerLimits {
  maxConcurrent: number;
  maxSteps: number;
  maxRuntimeMs: number;
  maxRevisions: number;
}

export const DEFAULT_WORKER_SETTINGS: WorkerProfileSettings = {
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

export function createWorkerProfile(
  model: ModelClient,
  settings: WorkerProfileSettings = DEFAULT_WORKER_SETTINGS,
  fileCheckpoints = true,
): AgentProfile {
  const tools = new ToolRegistry();
  registerWorkerTools(tools);
  return {
    id: WORKER_PROFILE_ID,
    model,
    thinkingLevel: resolveWorkerThinkingLevel(model, settings.thinkingLevel),
    tools,
    systemPrompt: workerSystemPrompt(fileCheckpoints),
  };
}
