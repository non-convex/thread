export * from "./runtime.js";
export { ThreadApp, type ThreadAppOptions, type InputResult } from "./app/thread-app.js";
export { ProjectService } from "./project/service.js";
export { discoverProjectRoot } from "./project/discovery.js";
export { SessionTreeService, type PlannedTurn } from "./session-tree/service.js";
export { SessionTreeRepository } from "./session-tree/repository.js";
export { SessionTreeProjection, SessionTreeCorruptionError } from "./session-tree/projection.js";
export { SessionRecallService, type SessionRecallOptions } from "./session-recall/service.js";
export type { RecallSearchResult, RecallSearchHit, SessionTurnDetail, ReadOptions } from "./session-recall/types.js";
export { FileHistoryService, type FileEditTracker, type FileContents } from "./file-history/service.js";
export { FileHistoryStore } from "./file-history/store.js";
export { ContextBuilder, type BuiltContext } from "./context/builder.js";
export {
  ContextCompactionService,
  COMPACTION_MIN_RETAINED_STEPS,
  COMPACTION_HISTORY_RESERVE_TOKENS,
  COMPACTION_PROGRESS_RESERVE_TOKENS,
  COMPACTION_TARGET_TOKENS,
} from "./context/compaction/index.js";
export { AgentRuntime } from "./agent/runtime.js";
export { AgentStepRunner, type AgentStepOptions, type AgentStepResult } from "./agent/step-runner.js";
export { type ExecutionJournal, type ToolExecutionFact } from "./agent/execution-journal.js";
export {
  AgentProfileRegistry,
  MAIN_AGENT_PROFILE_ID,
} from "./agent/profile.js";
export { AgentTaskOrchestrator, type AgentTaskOutcome } from "./agent-task/orchestrator.js";
export { AgentTaskRepository } from "./agent-task/repository.js";
export {
  createImplementationWorkerProfile,
  DEFAULT_IMPLEMENTATION_WORKER_SETTINGS,
  IMPLEMENTATION_WORKER_PROFILE_ID,
  type ImplementationWorkerProfileSettings,
} from "./agent-task/profile.js";
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
  type AttributionConfig,
  type ImplementationWorkerConfig,
  type DreamerConfig,
  type CustomModelConfig,
  type CustomProviderConfig,
  type LoadedThreadConfig,
  type ModelOverrideConfig,
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
  type DreamerState,
  type ThreadState,
  type ResolvedMainModelSelection,
} from "./config/thread-state.js";
export {
  createDreamerProfile,
  DEFAULT_DREAMER_THINKING_LEVEL,
  DREAMER_MAX_RUNTIME_MS,
  DREAMER_PROFILE_ID,
} from "./dreamer/profile.js";
export {
  DREAMER_IDLE_MS,
  DREAMER_IDLE_TURNS,
  DreamerScheduler,
  type DreamerSchedulerOptions,
} from "./dreamer/scheduler.js";
export { dreamerConversation } from "./dreamer/review.js";
export {
  GLOBAL_MEMORY_FILE,
  GlobalMemorySnapshots,
  formatGlobalMemoryPrompt,
  getGlobalMemoryPath,
} from "./global-memory.js";
export type { ExtensionAPI } from "./extensions/api.js";
export type {
  ThreadCommand,
  ThreadCommandContext,
  CommandResult,
  EphemeralView,
  AgentPickerItem,
  HistoryViewItem,
} from "./commands/types.js";
export {
  formatSkillsSection,
  skillsDirectory,
} from "./skills/loader.js";
export type { UiEvent, UiEventSink } from "./ui/events.js";
export type * from "./domain.js";

export const THREAD_VERSION = "0.1.0";
