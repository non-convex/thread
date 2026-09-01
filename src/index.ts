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
export {
  ContextCompactionService,
  COMPACTION_MIN_RETAINED_TURNS,
  COMPACTION_SUMMARY_RESERVE_TOKENS,
  COMPACTION_TARGET_TOKENS,
  type CompactionResult,
} from "./context/compaction.js";
export { AgentRuntime, type TurnResult } from "./agent/runtime.js";
export { AgentStepRunner, type AgentStepOptions, type AgentStepResult } from "./agent/step-runner.js";
export { type ExecutionJournal, type ToolExecutionFact } from "./agent/execution-journal.js";
export { AgentTaskOrchestrator, type AgentTaskOutcome, type TaskInspection } from "./agent-task/orchestrator.js";
export { AgentTaskRepository } from "./agent-task/repository.js";
export {
  AgentProfileRegistry,
  createImplementationWorkerProfile,
  DEFAULT_IMPLEMENTATION_WORKER_SETTINGS,
  IMPLEMENTATION_WORKER_PROFILE_ID,
  type ImplementationWorkerProfileSettings,
} from "./agent-task/profile.js";
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
  DEFAULT_THREAD_CONFIG_FILE,
  getThreadHome,
  getDefaultThreadConfigPath,
  getPiAgentDir,
  loadThreadConfig,
  type ThreadConfig,
  type AgentProfileConfig,
  type CustomModelConfig,
  type CustomProviderConfig,
  type LoadedThreadConfig,
  type ModelSelectionConfig,
  type SupportedCustomApi,
} from "./config/thread-config.js";
export {
  DEFAULT_THREAD_STATE_FILE,
  getThreadStatePath,
  loadThreadState,
  resolveMainModelSelection,
  saveThreadState,
  type ImplementationWorkerState,
  type ThreadState,
  type ResolvedMainModelSelection,
} from "./config/thread-state.js";
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
