import { type Message, type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import type { ExtensionEvents } from "../extensions/events.js";
import type { SessionTreeService } from "../session-tree/service.js";
import type { AgentTool, ToolRegistry, ToolResult } from "../tools/types.js";
import type { AskPresenter } from "../ui/ask.js";
import { safeUiEvent, type UiEventSink } from "../ui/events.js";

export class ToolRunner {
  constructor(
    private readonly rootPath: string,
    private readonly tree: SessionTreeService,
    private readonly tools: ToolRegistry,
    private readonly extensions: ExtensionEvents,
    private readonly askPresenter?: () => AskPresenter | undefined,
  ) {}

  async run(
    turnId: string,
    assistantEntryId: string,
    toolIndex: number,
    call: ToolCall,
    signal: AbortSignal,
    onUiEvent?: UiEventSink,
  ): Promise<Message> {
    const tool = this.tools.get(call.name);
    let args = call.arguments as Record<string, unknown>;
    let result: ToolResult | undefined;
    let replay: AgentTool["replay"] = "never";
    if (!tool) {
      result = { content: `Unknown tool: ${call.name}`, isError: true };
    } else {
      replay = tool.replay;
      try {
        args = validateToolArguments(
          { name: tool.name, description: tool.description, parameters: tool.parameters },
          call,
        ) as Record<string, unknown>;
      } catch (error) {
        result = { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    }
    const transformed = await this.extensions.emit("before_tool_call", { toolName: call.name, args });
    args = transformed.args;
    if (tool && !result && !transformed.denied) {
      try {
        args = validateToolArguments(
          { name: tool.name, description: tool.description, parameters: tool.parameters },
          { ...call, arguments: args },
        ) as Record<string, unknown>;
      } catch (error) {
        result = { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    }
    await this.tree.appendToolExecution(turnId, {
      assistantEntryId,
      toolIndex,
      toolCallId: call.id,
      toolName: call.name,
      effectiveArgs: args,
      replay,
    });
    safeUiEvent(onUiEvent, { type: "tool_started", id: call.id, name: call.name, args });
    if (!result) {
      if (transformed.denied) {
        result = { content: transformed.denyReason ?? `Tool ${call.name} was denied`, isError: true };
      } else {
        try {
          const ask = this.askPresenter?.();
          result = await tool!.execute(args, {
            rootPath: this.rootPath,
            signal,
            ...(ask ? { ask } : {}),
          });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          result = { content: error instanceof Error ? error.message : String(error), isError: true };
        }
      }
    }
    let visible: { toolName: string; raw: ToolResult; modelContent: string };
    try {
      visible = await this.extensions.emit("tool_result", {
        toolName: call.name,
        raw: structuredClone(result),
        modelContent: result.content,
      });
    } catch (error) {
      visible = {
        toolName: call.name,
        raw: structuredClone(result),
        modelContent: `${result.content}\n[tool_result extension failed: ${error instanceof Error ? error.message : String(error)}]`,
      };
    }
    safeUiEvent(onUiEvent, {
      type: "tool_finished",
      id: call.id,
      name: call.name,
      result: structuredClone(result),
      isError: result.isError,
    });
    const message: Message = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: visible.modelContent }],
      details: { raw: result },
      isError: result.isError,
      timestamp: Date.now(),
    };
    await this.tree.appendMessage(turnId, message);
    return message;
  }
}
