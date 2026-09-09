/** Supported headless entrypoint. Terminal rendering lives in thread/tui. */
export { ThreadRuntime } from "./core/runtime/thread-runtime.js";
export type { ThreadRuntimeOptions, PromptOptions, RewindOptions } from "./core/runtime/options.js";
export type { BuiltinToolName } from "./core/tools/builtins.js";
export type { RuntimeEvent, RuntimeEventSink, RuntimeScope } from "./core/runtime/events.js";
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
  PiModelClient,
  type ModelAuthProviderStatus,
  type ModelCatalog,
  type ModelCatalogOptions,
  type ModelClient,
  type ModelDescriptor,
  type ModelRequestOptions,
  type ModelRetryCallbacks,
} from "./core/agent/model-client.js";
export type { TurnResult } from "./core/agent/runtime.js";
export type { AgentProfile } from "./core/agent/profile.js";
export type { AgentTool, ToolContext, ToolResult } from "./core/tools/types.js";
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
export type { CompactionResult } from "./core/context/compaction/index.js";
export { loadSkills, type LoadedSkills, type Skill, type SkillDiagnostic, type SkillPaths } from "./core/skills/loader.js";
