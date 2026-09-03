import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelClient } from "./model-client.js";
import type { ToolRegistry } from "../tools/types.js";

export const MAIN_AGENT_PROFILE_ID = "main";

/** The model-facing parts shared by every kind of Thread agent. */
export interface AgentProfile {
  id: string;
  model: ModelClient;
  thinkingLevel: ModelThinkingLevel;
  tools: ToolRegistry;
  systemPrompt: string;
}

export interface AgentProfileDiagnostic {
  profileId: string;
  level: "warning" | "error";
  message: string;
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

  clearDiagnostics(profileId: string): void {
    this.currentDiagnostics = this.currentDiagnostics.filter((item) => item.profileId !== profileId);
  }
}
