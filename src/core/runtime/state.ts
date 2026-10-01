import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelSelectionConfig } from "../config/model-config.js";

export interface WorkerState {
  enabled: boolean;
  model?: ModelSelectionConfig;
}

export type DreamerState = WorkerState;

export interface SessionModelPreferences {
  model?: ModelSelectionConfig;
  thinkingLevel?: ModelThinkingLevel;
}

/** Session model choices and project-wide agent choices reported through the runtime state callback. */
export interface ThreadState {
  sessions?: Record<string, SessionModelPreferences>;
  agents?: {
    worker?: WorkerState;
    dreamer?: DreamerState;
  };
}
