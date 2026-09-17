/** Supported headless entrypoint. Terminal rendering lives in thread/tui. */
export { ThreadRuntime } from "./core/runtime/thread-runtime.js";
export type { ThreadRuntimeOptions, PromptOptions, RewindOptions } from "./core/runtime/options.js";
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
export type { TurnResult } from "./core/agent/runtime.js";
export type { AgentProfile } from "./core/agent/profile.js";
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
export type { ProjectSession, SessionEntry, Turn } from "./core/session-tree/model.js";
export type { RewindCandidate } from "./core/session-tree/service.js";
export type { CompactionResult } from "./core/context/compaction/service.js";
export { loadSkills, type LoadedSkills, type Skill, type SkillDiagnostic, type SkillPaths } from "./core/skills/loader.js";

export type { ModelAttemptEvent } from "./core/agent/model-observation.js";
export type { AgentTask, AgentTaskRun, AgentTaskSummary } from "./core/agent-task/model.js";
