/** Supported headless entrypoint. Terminal rendering lives in thread/tui. */
export { ThreadRuntime } from "./core/runtime/thread-runtime.js";
export type { ThreadRuntimeOptions, PromptOptions, GoalOptions, RewindOptions } from "./core/runtime/options.js";
export type { BuiltinToolName } from "./core/tools/builtins.js";
export type { RuntimeEvent, RuntimeEventSink, RuntimeScope, RuntimeSubscriptionOptions, ModelEvent } from "./core/runtime/events.js";
export type { ExecutionIdentity, HostToolCall, HostToolDecision, HostToolPolicy } from "./core/runtime/policy.js";
export { RuntimeLimitError, type ExecutionLimits, type RuntimeLimit } from "./core/runtime/limits.js";
export {
  ASK_MAX_QUESTIONS,
  AskDismissedError,
  AskService,
  type AskAnswers,
  type AskOption,
  type AskPresenter,
  type AskQuestion,
  type AskRequest,
  type AskResultDetails,
} from "./core/runtime/interaction.js";
export {
  createBuiltinModelClient,
  createConfiguredModelCatalog,
  createConfiguredModelClient,
  PiModelCatalog,
  type ModelAuthProviderStatus,
  type ModelCatalog,
  type ModelCatalogOptions,
  type ModelDescriptor,
} from "./core/agent/model-catalog.js";
export { PiModelClient, type ModelClient, type ModelRequestOptions, type ModelRetryCallbacks } from "./core/agent/model-client.js";
export type { TurnResult } from "./core/agent/runner.js";
export type { AgentProfile, AgentProfileDiagnostic } from "./core/agent/profile.js";
export type { WorkerProfileSettings, WorkerLimits } from "./core/agent-task/profile.js";
export type { DreamerStatus } from "./core/dreamer/scheduler.js";
export type { SessionRecallOptions } from "./core/session-recall/service.js";
export type { RecallSearchResult, RecallSearchHit } from "./core/session-recall/types.js";
export type { ExtensionEventMap, ExtensionEventType, ExtensionHandler } from "./core/extensions/events.js";
export type { AgentTool, ToolContext, ToolResult, ToolResultMetadata, ToolOutcome } from "./core/tools/types.js";
export type { FileWriteScope } from "./core/tools/path-safety.js";
export type {
  ToolEffect,
  ToolExecutionMode,
  ToolExecutionPolicy,
  ToolPlanningContext,
  ToolResourceAccess,
  ToolResourceClaim,
  ToolResourceScope,
} from "./core/tools/execution.js";
export { claim, entireWorkspaceClaim, noResources, singletonResource, workspacePathClaim } from "./core/tools/execution.js";
export type { Project } from "./core/project/model.js";
export type { ProjectSession, SessionEntry, SessionGoal, Turn } from "./core/session-tree/model.js";
export type { RewindCandidate } from "./core/session-tree/service.js";
export type { CompactionResult } from "./core/context/compaction/service.js";
export { loadSkills, type LoadedSkills, type Skill, type SkillDiagnostic, type SkillPaths } from "./core/skills/loader.js";

export type { ModelAttemptEvent } from "./core/agent/model-observation.js";
export type { PromptCacheDiagnostic, PromptCacheSectionDiagnostic } from "./core/agent/prompt-cache-diagnostics.js";
export type { AgentTask, AgentTaskRun, AgentTaskSummary } from "./core/agent-task/model.js";
