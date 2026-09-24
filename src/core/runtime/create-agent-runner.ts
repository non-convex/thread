import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { AgentRunner } from "../agent/runner.js";
import type { ModelClient } from "../agent/model-client.js";
import { ToolCallExecutor } from "../agent/tool-call-executor.js";
import { TurnRunner } from "../agent/turn-runner.js";
import type { AgentTaskOrchestrator } from "../agent-task/orchestrator.js";
import type { ContextBuilder } from "../context/builder.js";
import { ContextCompactionService } from "../context/compaction/service.js";
import type { ExtensionEvents } from "../extensions/events.js";
import type { SessionTreeService } from "../session-tree/service.js";
import type { ToolRegistry } from "../tools/types.js";
import type { AskPresenter } from "./interaction.js";
import type { FileHistoryService } from "../file-history/service.js";
import type { HostToolPolicy } from "./policy.js";
import { GlobalMemoryAccess } from "../global-memory.js";

export interface CreateAgentRunnerInput {
  model: ModelClient;
  reasoning?: ThinkingLevel;
  rootPath: string;
  systemPrompt: string;
  tree: SessionTreeService;
  fileHistory: FileHistoryService;
  contextBuilder: ContextBuilder;
  tools: ToolRegistry;
  extensions: ExtensionEvents;
  agentTasks: AgentTaskOrchestrator;
  askPresenter: () => AskPresenter | undefined;
  writableExternalPaths?: readonly string[];
  writableExternalDirectories?: readonly string[];
  protectedWritePaths: readonly string[];
  globalMemoryPath?: string;
  toolPolicy?: HostToolPolicy;
  profileId?: string;
}

export function createAgentRunner(input: CreateAgentRunnerInput): AgentRunner {
  const compaction = new ContextCompactionService(
    input.tree,
    input.model,
    input.reasoning,
  );
  const toolRunner = new ToolCallExecutor(
    input.rootPath,
    input.tools,
    input.extensions,
    {
      acceptsImages: input.model.acceptsImages === true,
      askPresenter: input.askPresenter,
      writableExternalPaths: input.writableExternalPaths ?? [],
      writableExternalDirectories: input.writableExternalDirectories ?? [],
      protectedWritePaths: input.protectedWritePaths,
      fileHistory: (turnId) => input.fileHistory.forTurn(turnId),
      ...(input.globalMemoryPath ? { globalMemory: new GlobalMemoryAccess(input.globalMemoryPath) } : {}),
      ...(input.toolPolicy ? { toolPolicy: input.toolPolicy } : {}),
      ...(input.profileId ? { agentId: input.profileId } : {}),
    },
  );
  const runner = new TurnRunner(
    input.model,
    input.tree,
    input.contextBuilder,
    compaction,
    input.tools,
    toolRunner,
    input.extensions,
    input.systemPrompt,
    input.reasoning,
  );
  return new AgentRunner(input.tree, runner, input.extensions, input.agentTasks, input.fileHistory.captureEnabled);
}
