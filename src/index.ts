export { ThreadApp, type ThreadAppOptions, type InputResult } from "./app.js";
export {
  createBuiltinModelClient,
  createConfiguredModelCatalog,
  createConfiguredModelClient,
  PiModelCatalog,
  PiModelClient,
  type ModelCatalog,
  type ModelClient,
  type ModelDescriptor,
} from "./agent/model-client.js";
export {
  DEFAULT_THREAD_HOME_NAME,
  DEFAULT_MODEL_CONFIG_FILE,
  getThreadHome,
  getDefaultModelConfigPath,
  getPiAgentDir,
  loadModelConfig,
  type ThreadModelConfig,
  type CustomModelConfig,
  type CustomProviderConfig,
  type LoadedModelConfig,
  type ModelSelectionConfig,
  type SupportedCustomApi,
} from "./config/model-config.js";
export {
  DEFAULT_MODEL_STATE_FILE,
  getModelStatePath,
  loadModelState,
  resolveModelSelection,
  saveModelState,
  type ModelState,
  type ResolvedModelSelection,
} from "./config/model-state.js";
export type { ExtensionAPI } from "./extensions/api.js";
export type {
  ThreadCommand,
  ThreadCommandContext,
  CommandResult,
  EphemeralView,
  HistoryViewItem,
} from "./commands/types.js";
export type { AgentTool, ToolContext, ToolResult } from "./tools/types.js";
export {
  formatSkillsSection,
  loadSkills,
  skillsDirectory,
  type LoadedSkills,
  type Skill,
  type SkillDiagnostic,
} from "./skills/loader.js";
export type { UiEvent, UiEventSink } from "./ui/events.js";
export { ThreadTerminalApp, type TerminalAppOptions, type TerminalMode } from "./ui/terminal/app.js";
export type * from "./domain.js";

export const THREAD_VERSION = "0.1.0";
