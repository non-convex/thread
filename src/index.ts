export { ThreadApp, type ThreadAppOptions, type InputResult } from "./app.js";
export { ProjectService } from "./project/service.js";
export { discoverProjectRoot } from "./project/discovery.js";
export { SessionTreeService, type PlannedTurn, type RewindCandidate } from "./session-tree/service.js";
export { SessionTreeRepository } from "./session-tree/repository.js";
export { SessionTreeProjection, SessionTreeCorruptionError } from "./session-tree/projection.js";
export { SessionSearchService } from "./session-tree/search.js";
export { WorkspaceStateService } from "./workspace-state/service.js";
export { WorkspaceStateRepository } from "./workspace-state/repository.js";
export { ContextBuilder, type BuiltContext } from "./context/builder.js";
export { ContextCache, type CompactionCacheEntry } from "./context/cache.js";
export { AgentRuntime, type TurnResult } from "./agent/runtime.js";
export {
  createBuiltinModelClient,
  createConfiguredModelCatalog,
  createConfiguredModelClient,
  PiModelCatalog,
  PiModelClient,
  type ModelAuthProviderStatus,
  type ModelCatalog,
  type ModelCatalogOptions,
  type ModelClient,
  type ModelDescriptor,
} from "./agent/model-client.js";
export {
  DEFAULT_AUTH_FILE,
  getAuthFilePath,
  ThreadCredentialStore,
} from "./auth/credential-store.js";
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
export type {
  ToolEffect,
  ToolExecutionMode,
  ToolExecutionPolicy,
  ToolPlanningContext,
  ToolResourceAccess,
  ToolResourceClaim,
  ToolResourceScope,
} from "./tools/execution.js";
export { claim, entireWorkspaceClaim, noResources, singletonResource, workspacePathClaim } from "./tools/execution.js";
export {
  ASK_MAX_QUESTIONS,
  AskDismissedError,
  AskService,
  type AskAnswers,
  type AskOption,
  type AskPresenter,
  type AskQuestion,
  type AskRequest,
} from "./ui/ask.js";
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
