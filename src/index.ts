export * from "./runtime.js";
export { ThreadApp, type ThreadAppOptions, type InputResult } from "./app/thread-app.js";
export { ProjectService } from "./core/project/service.js";
export { discoverProjectRoot } from "./core/project/discovery.js";
export { SessionTreeService, type PlannedTurn } from "./core/session-tree/service.js";
export { SessionTreeRepository } from "./core/session-tree/repository.js";
export { SessionTreeProjection, SessionTreeCorruptionError } from "./core/session-tree/projection.js";
export { SessionRecallService, type SessionRecallOptions } from "./core/session-recall/service.js";
export type { RecallSearchResult, RecallSearchHit, SessionTurnDetail, ReadOptions } from "./core/session-recall/types.js";
export { FileHistoryService, type FileEditTracker, type FileContents } from "./core/file-history/service.js";
export { FileHistoryStore } from "./core/file-history/store.js";
export { ContextBuilder, type BuiltContext } from "./core/context/builder.js";
export {
  ContextCompactionService,
  COMPACTION_MIN_RETAINED_STEPS,
  COMPACTION_HISTORY_RESERVE_TOKENS,
  COMPACTION_PROGRESS_RESERVE_TOKENS,
  COMPACTION_TARGET_TOKENS,
} from "./core/context/compaction/index.js";
export { AgentRuntime } from "./core/agent/runtime.js";
export { AgentStepRunner, type AgentStepOptions, type AgentStepResult } from "./core/agent/step-runner.js";
export { type ExecutionJournal, type ToolExecutionFact } from "./core/agent/execution-journal.js";
export {
  AgentProfileRegistry,
  MAIN_AGENT_PROFILE_ID,
} from "./core/agent/profile.js";
export { AgentTaskOrchestrator, type AgentTaskOutcome } from "./core/agent-task/orchestrator.js";
export { AgentTaskRepository } from "./core/agent-task/repository.js";
export {
  createWorkerProfile,
  DEFAULT_WORKER_SETTINGS,
  WORKER_PROFILE_ID,
  type WorkerProfileSettings,
} from "./core/agent-task/profile.js";
export {
  DEFAULT_AUTH_FILE,
  getAuthFilePath,
  ThreadCredentialStore,
} from "./core/auth/credential-store.js";
export { DEFAULT_THREAD_HOME_NAME, getThreadHome } from "./core/config/home.js";
export {
  DEFAULT_THREAD_CONFIG_FILE,
  getDefaultThreadConfigPath,
  getPiAgentDir,
  loadThreadConfig,
  type ThreadConfig,
  type AttributionConfig,
  type WorkerConfig,
  type DreamerConfig,
  type LoadedThreadConfig,
} from "./app/config/thread-config.js";
export type {
  CustomModelConfig,
  CustomProviderConfig,
  ModelOverrideConfig,
  ModelSelectionConfig,
  SupportedCustomApi,
} from "./core/config/model-config.js";
export {
  DEFAULT_THREAD_STATE_FILE,
  getThreadStatePath,
  loadThreadState,
  resolveMainModelSelection,
  saveThreadState,
  type ResolvedMainModelSelection,
} from "./app/config/thread-state.js";
export type { WorkerState, DreamerState, ThreadState } from "./core/runtime/state.js";
export {
  createDreamerProfile,
  DEFAULT_DREAMER_THINKING_LEVEL,
  DREAMER_MAX_RUNTIME_MS,
  DREAMER_PROFILE_ID,
} from "./core/dreamer/profile.js";
export {
  DREAMER_IDLE_MS,
  DREAMER_IDLE_TURNS,
  DreamerScheduler,
  type DreamerSchedulerOptions,
} from "./core/dreamer/scheduler.js";
export { dreamerConversation } from "./core/dreamer/review.js";
export {
  GLOBAL_MEMORY_FILE,
  GlobalMemorySnapshots,
  formatGlobalMemoryPrompt,
  getGlobalMemoryPath,
} from "./core/global-memory.js";
export type { ExtensionAPI } from "./app/extensions/api.js";
export type {
  ThreadCommand,
  ThreadCommandContext,
  CommandResult,
  EphemeralView,
  AgentPickerItem,
  HistoryViewItem,
} from "./app/commands/types.js";
export {
  formatSkillsSection,
  skillsDirectory,
} from "./core/skills/loader.js";
export type { UiEvent, UiEventSink } from "./ui/events.js";
export type * from "./core/domain.js";

export const THREAD_VERSION = "0.1.0";
