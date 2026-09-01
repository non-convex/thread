import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { AgentRuntime } from "../agent/runtime.js";
import type { ModelClient } from "../agent/model-client.js";
import { ToolCallExecutor } from "../agent/tool-call-executor.js";
import { TurnRunner } from "../agent/turn-runner.js";
import type { AgentTaskOrchestrator } from "../agent-task/orchestrator.js";
import type { ContextBuilder } from "../context/builder.js";
import { ContextCompactionService } from "../context/compaction.js";
import type { ExtensionEvents } from "../extensions/events.js";
import type { SessionTreeService } from "../session-tree/service.js";
import type { ToolRegistry } from "../tools/types.js";
import type { AskPresenter } from "../ui/ask.js";
import type { WorkspaceStateService } from "../workspace-state/service.js";

export interface RuntimeFactoryInput {
  model: ModelClient;
  reasoning?: ThinkingLevel;
  rootPath: string;
  systemPrompt: string;
  tree: SessionTreeService;
  workspace: WorkspaceStateService;
  contextBuilder: ContextBuilder;
  tools: ToolRegistry;
  extensions: ExtensionEvents;
  agentTasks: AgentTaskOrchestrator;
  askPresenter: () => AskPresenter | undefined;
}

export class RuntimeFactory {
  create(input: RuntimeFactoryInput): AgentRuntime {
    const maxOutputTokens = Math.min(
      input.model.maxOutputTokens,
      16_384,
      Math.max(1_024, Math.floor(input.model.contextWindow * 0.2)),
    );
    const compaction = new ContextCompactionService(input.tree, input.model, input.reasoning);
    const toolRunner = new ToolCallExecutor(input.rootPath, input.tools, input.extensions, input.askPresenter);
    const runner = new TurnRunner(
      input.model,
      input.tree,
      input.contextBuilder,
      compaction,
      input.tools,
      toolRunner,
      input.extensions,
      input.systemPrompt,
      maxOutputTokens,
      input.reasoning,
    );
    return new AgentRuntime(input.tree, input.workspace, runner, input.extensions, input.agentTasks);
  }
}
