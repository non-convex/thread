/** Supported headless entrypoint. Terminal rendering lives in thread/tui. */
export { ThreadRuntime, type ThreadRuntimeOptions, type PromptOptions, type RewindOptions } from "./runtime/thread-runtime.js";
export type { BuiltinToolName } from "./tools/builtins.js";
export type { RuntimeEvent, RuntimeEventSink, RuntimeScope } from "./runtime/events.js";
export type { ExecutionIdentity, HostToolCall, HostToolDecision, HostToolPolicy } from "./runtime/policy.js";
export { RuntimeLimitError, type ExecutionLimits, type RuntimeLimit } from "./runtime/limits.js";
export {
  ASK_MAX_QUESTIONS,
  AskDismissedError,
  AskService,
  type AskAnswers,
  type AskOption,
  type AskPresenter,
  type AskQuestion,
  type AskRequest,
} from "./runtime/interaction.js";
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
} from "./agent/model-client.js";
export type { TurnResult } from "./agent/runtime.js";
export type { AgentProfile } from "./agent/profile.js";
export type { AgentTool, ToolContext, ToolResult } from "./tools/types.js";
export type { FileWriteScope } from "./tools/path-safety.js";
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
export type { Project } from "./project/model.js";
export type { ProjectSession, SessionEntry, Turn } from "./session-tree/model.js";
export type { RewindCandidate } from "./session-tree/service.js";
export type { CompactionResult } from "./context/compaction/index.js";
export { loadSkills, type LoadedSkills, type Skill, type SkillDiagnostic, type SkillPaths } from "./skills/loader.js";
