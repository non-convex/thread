import type { Message, ToolCall } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionEvents } from "../extensions/events.js";
import {
  validateToolResourceClaims,
  type ToolExecutionPolicy,
  type ToolResourceClaim,
} from "../tools/execution.js";
import type { AgentTool, ToolContext, ToolRegistry, ToolResult } from "../tools/types.js";
import type { AskPresenter } from "../runtime/interaction.js";
import { safeExecutionEvent, type ExecutionEventSink } from "../runtime/events.js";
import type { FileEditTracker } from "../file-history/service.js";
import type { ExecutionJournal } from "./execution-journal.js";
import type { ExecutionIdentity, HostToolPolicy } from "../runtime/policy.js";

export interface PreparedToolCall {
  journal: ExecutionJournal;
  assistantEntryId: string;
  contentIndex: number;
  toolIndex: number;
  call: ToolCall;
  args: Record<string, unknown>;
  replay: AgentTool["replay"];
  policy: ToolExecutionPolicy<Record<string, unknown>>;
  resources: readonly ToolResourceClaim[];
  tool?: AgentTool;
  immediateResult?: ToolResult;
}

const immediatePolicy: ToolExecutionPolicy<Record<string, unknown>> = {
  effect: "read",
  mode: "parallel",
  resources: () => [],
};

function errorResult(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true };
}

export interface ToolExecutorOptions {
  askPresenter?: () => AskPresenter | undefined;
  writableExternalPaths?: readonly string[];
  fileHistory?: (executionId: string) => FileEditTracker;
  toolPolicy?: HostToolPolicy;
  agentId?: string;
  writeScope?: readonly import("../tools/path-safety.js").FileWriteScope[];
}

/**
 * Owns one tool invocation's lifecycle but not batch scheduling.
 *
 * prepare() performs all sequential preflight work and durably records the call.
 * execute() begins only when ToolScheduler grants it a lane. It returns a
 * model-facing result without persisting it; the batch commits result messages
 * later in assistant source order.
 */
export class ToolCallExecutor {
  constructor(
    private readonly rootPath: string,
    private readonly tools: ToolRegistry,
    private readonly extensions: ExtensionEvents,
    private readonly options: ToolExecutorOptions = {},
  ) {}

  async prepare(input: {
    journal: ExecutionJournal;
    assistantEntryId: string;
    contentIndex: number;
    toolIndex: number;
    call: ToolCall;
    signal: AbortSignal;
  }): Promise<PreparedToolCall> {
    input.signal.throwIfAborted();
    const tool = this.tools.get(input.call.name);
    let args = input.call.arguments as Record<string, unknown>;
    let immediateResult: ToolResult | undefined;
    let replay: AgentTool["replay"] = "never";

    if (!tool) {
      immediateResult = { content: `Unknown tool: ${input.call.name}`, isError: true };
    } else {
      replay = tool.replay;
      try {
        args = validateToolArguments(
          { name: tool.name, description: tool.description, parameters: tool.parameters },
          input.call,
        ) as Record<string, unknown>;
      } catch (error) {
        immediateResult = errorResult(error);
      }
    }

    const transformed = await this.extensions.emit("before_tool_call", {
      toolName: input.call.name,
      args,
    });
    args = transformed.args;
    if (transformed.denied) {
      immediateResult = { content: transformed.denyReason ?? `Tool ${input.call.name} was denied`, isError: true };
    } else if (tool && !immediateResult) {
      try {
        args = validateToolArguments(
          { name: tool.name, description: tool.description, parameters: tool.parameters },
          { ...input.call, arguments: args },
        ) as Record<string, unknown>;
      } catch (error) {
        immediateResult = errorResult(error);
      }
    }

    // Host authorization is the final preflight gate. Extensions have already
    // rewritten arguments, and neither policy nor later hooks can change them.
    if (tool && !immediateResult && this.options.toolPolicy) {
      try {
        const decision = await this.options.toolPolicy({
          ...this.identity(input.journal),
          assistantEntryId: input.assistantEntryId,
          toolCallId: input.call.id,
          toolName: input.call.name,
          args: structuredClone(args),
          signal: input.signal,
        });
        if (!decision || decision.allow !== true) {
          immediateResult = { content: decision?.reason ?? `Host denied tool ${input.call.name}`, isError: true };
        }
      } catch (error) {
        if (input.signal.aborted) throw error;
        immediateResult = errorResult(error);
      }
    }
    input.signal.throwIfAborted();

    let policy = tool?.execution as ToolExecutionPolicy<Record<string, unknown>> | undefined;
    let resources: readonly ToolResourceClaim[] = [];
    if (!policy || immediateResult) {
      policy = immediatePolicy;
    } else {
      try {
        resources = validateToolResourceClaims(
          await policy.resources(args, {
            rootPath: this.rootPath,
            writableExternalPaths: this.options.writableExternalPaths ?? [],
            signal: input.signal,
          }),
        );
      } catch (error) {
        immediateResult = errorResult(error);
        policy = immediatePolicy;
      }
    }

    // appendToolExecution is the side-effect durability barrier. The scheduler
    // cannot call execute() until this factual record has reached the log.
    await input.journal.appendToolExecution({
      assistantEntryId: input.assistantEntryId,
      toolIndex: input.toolIndex,
      toolCallId: input.call.id,
      toolName: input.call.name,
      effectiveArgs: args,
      replay,
    });

    return {
      journal: input.journal,
      assistantEntryId: input.assistantEntryId,
      contentIndex: input.contentIndex,
      toolIndex: input.toolIndex,
      call: input.call,
      args,
      replay,
      policy,
      resources,
      ...(tool ? { tool } : {}),
      ...(immediateResult ? { immediateResult } : {}),
    };
  }

  async execute(prepared: PreparedToolCall, signal: AbortSignal, ui?: ExecutionEventSink): Promise<Message> {
    signal.throwIfAborted();
    safeExecutionEvent(ui, {
      type: "tool_started",
      id: prepared.call.id,
      name: prepared.call.name,
      args: prepared.args,
    });

    let result = prepared.immediateResult;
    if (!result && prepared.tool) {
      const ask = this.options.askPresenter?.();
      const context: ToolContext = {
        ...(this.options.fileHistory ? { fileHistory: this.options.fileHistory(prepared.journal.executionId) } : {}),
        rootPath: this.rootPath,
        ...(this.options.writeScope ? { writeScope: structuredClone(this.options.writeScope) } : {}),
        ...(this.options.writableExternalPaths?.length
          ? { writableExternalPaths: this.options.writableExternalPaths }
          : {}),
        signal,
        invocation: {
          ...this.identity(prepared.journal),
          executionId: prepared.journal.executionId,
          assistantEntryId: prepared.assistantEntryId,
          toolCallId: prepared.call.id,
        },
        ...(ui ? { onUiEvent: ui } : {}),
        ...(ask ? { ask } : {}),
      };
      try {
        result = await prepared.tool.execute(prepared.args, context);
      } catch (error) {
        if (signal.aborted || (error as Error).name === "AbortError") throw error;
        result = errorResult(error);
      }
    }
    const settled = result ?? { content: `Unknown tool: ${prepared.call.name}`, isError: true };
    let modelContent = settled.content;
    if (this.extensions.hasHandlers("tool_result")) {
      try {
        const visible = await this.extensions.emit("tool_result", {
          toolName: prepared.call.name,
          raw: structuredClone(settled),
          modelContent,
        });
        modelContent = visible.modelContent;
      } catch (error) {
        modelContent = `${settled.content}\n[tool_result extension failed: ${error instanceof Error ? error.message : String(error)}]`;
      }
    }
    safeExecutionEvent(ui, {
      type: "tool_finished",
      id: prepared.call.id,
      name: prepared.call.name,
      isError: settled.isError,
      ...(settled.isError ? { error: settled.content } : {}),
      content: modelContent,
    });

    return {
      role: "toolResult",
      toolCallId: prepared.call.id,
      toolName: prepared.call.name,
      content: [{ type: "text", text: modelContent }],
      details: { raw: settled },
      isError: settled.isError,
      timestamp: Date.now(),
    };
  }

  private identity(journal: ExecutionJournal): ExecutionIdentity {
    return {
      executionId: journal.executionId,
      sessionId: journal.identity?.sessionId ?? null,
      turnId: journal.identity?.turnId ?? null,
      ...(journal.identity?.taskId ? { taskId: journal.identity.taskId } : {}),
      agentId: this.options.agentId ?? journal.identity?.agentId ?? "main",
    };
  }
}
