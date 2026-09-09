import type { TSchema } from "@earendil-works/pi-ai";
import { validateToolExecutionPolicy, type ToolExecutionPolicy } from "./execution.js";

export interface ToolResult {
  content: string;
  isError: boolean;
  details?: unknown;
}

export interface ToolContext {
  rootPath: string;
  /** Exact files outside rootPath that this agent may write. */
  writableExternalPaths?: readonly string[];
  /** Omitted: ordinary workspace policy. Empty: no built-in file writes are allowed. */
  writeScope?: readonly import("./path-safety.js").FileWriteScope[];
  signal: AbortSignal;
  fileHistory?: import("../file-history/service.js").FileEditTracker;
  invocation: {
    executionId: string;
    assistantEntryId: string;
    toolCallId: string;
    sessionId?: string | null;
    turnId?: string | null;
    taskId?: string;
    agentId?: string;
  };
  onUiEvent?: import("../runtime/events.js").ExecutionEventSink;
  /**
   * Present when the host can display a question and return an answer. Without
   * a presenter, the coding app's ask tool returns an unavailable result.
   */
  ask?: import("../runtime/interaction.js").AskPresenter;
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
