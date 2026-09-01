import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelClient } from "../agent/model-client.js";
import { registerImplementationWorkerTools } from "../tools/builtins.js";
import { ToolRegistry } from "../tools/types.js";
import type { AgentProfile, AgentProfileDiagnostic } from "./model.js";
import { IMPLEMENTATION_WORKER_SYSTEM_PROMPT } from "./prompt.js";

export const IMPLEMENTATION_WORKER_PROFILE_ID = "implementation-worker";

export interface ImplementationWorkerProfileSettings {
  thinkingLevel: ModelThinkingLevel;
  limits: AgentProfile["limits"];
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
    limits: { ...settings.limits },
    tools,
    systemPrompt: IMPLEMENTATION_WORKER_SYSTEM_PROMPT,
  };
}

export class AgentProfileRegistry {
  private readonly profiles = new Map<string, AgentProfile>();
  private currentDiagnostics: AgentProfileDiagnostic[];

  constructor(
    profiles: readonly AgentProfile[] = [],
    diagnostics: readonly AgentProfileDiagnostic[] = [],
  ) {
    this.currentDiagnostics = [...diagnostics];
    for (const profile of profiles) {
      if (this.profiles.has(profile.id)) throw new Error(`Duplicate agent profile: ${profile.id}`);
      this.profiles.set(profile.id, profile);
    }
  }

  get diagnostics(): readonly AgentProfileDiagnostic[] {
    return this.currentDiagnostics;
  }

  get(id: string): AgentProfile | undefined {
    return this.profiles.get(id);
  }

  require(id: string): AgentProfile {
    const profile = this.get(id);
    if (!profile) throw new Error(`Agent profile is unavailable: ${id}`);
    return profile;
  }

  list(): AgentProfile[] {
    return [...this.profiles.values()];
  }

  set(profile: AgentProfile): void {
    this.profiles.set(profile.id, profile);
  }

  delete(id: string): boolean {
    return this.profiles.delete(id);
  }

  setDiagnostics(diagnostics: readonly AgentProfileDiagnostic[]): void {
    this.currentDiagnostics = [...diagnostics];
  }
}
