import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelSelectionConfig } from "../config/model-config.js";

export interface ImplementationWorkerState {
  enabled: boolean;
  model?: ModelSelectionConfig;
}

export type DreamerState = ImplementationWorkerState;

/** Model and agent choices reported through the runtime state callback. */
export interface ThreadState {
  model?: ModelSelectionConfig;
  thinkingLevel?: ModelThinkingLevel;
  agents?: {
    "implementation-worker"?: ImplementationWorkerState;
    dreamer?: DreamerState;
  };
}
