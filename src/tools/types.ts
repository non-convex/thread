import type { TSchema } from "@earendil-works/pi-ai";
import { validateToolExecutionPolicy, type ToolExecutionPolicy } from "./execution.js";

export interface ToolResult {
  content: string;
  isError: boolean;
  details?: unknown;
}

export interface ToolContext {
  rootPath: string;
  signal: AbortSignal;
  invocation: {
    executionId: string;
    assistantEntryId: string;
    toolCallId: string;
  };
  onUiEvent?: import("../ui/events.js").UiEventSink;
  /**
   * Present when an interactive front end can put a question in front of the
   * user. Tools that need a decision stay unregistered without it, so a plain or
   * embedded session never parks a turn waiting for input nobody can give.
   */
  ask?: import("../ui/ask.js").AskPresenter;
}

export interface AgentTool<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: TSchema;
  replay: "safe" | "never";
  execution: ToolExecutionPolicy<TArgs>;
  execute(args: TArgs, context: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  register(tool: AgentTool): () => void {
    if (!tool.name.trim()) throw new Error("Tool name cannot be empty");
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    validateToolExecutionPolicy(tool.execution);
    this.tools.set(tool.name, tool);
    return () => this.tools.delete(tool.name);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  modelDefinitions() {
    return this.list().map(({ name, description, parameters }) => ({ name, description, parameters }));
  }
}
