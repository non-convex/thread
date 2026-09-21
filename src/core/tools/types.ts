import type { ImageContent, TSchema } from "@earendil-works/pi-ai";
import { validateToolExecutionPolicy, type ToolExecutionPolicy, type ToolPlanningContext, type ToolResourceClaim } from "./execution.js";

export interface ToolResult {
  content: string;
  /** Pixels attached to the model-facing tool result, not embedded in the display text. */
  images?: readonly ImageContent[];
  isError: boolean;
  details?: unknown;
  /** Version receipt for built-in file tools; persisted separately from model text. */
  fileObservation?: import("./file-read-state.js").FileObservation;
}

export type ToolOutcome = "completed" | "failed" | "cancelled" | "denied";

/** Saved with tool-result messages; presentation metadata is not model text. */
export interface ToolResultMetadata {
  /** Image bytes live only in the message content, not in presentation metadata. */
  raw: Omit<ToolResult, "images" | "fileObservation">;
  fileObservation?: import("./file-read-state.js").FileObservation;
  outcome: ToolOutcome;
  durationMs?: number;
}

export interface ToolContext {
  rootPath: string;
  /** Whether the model for this execution accepts image inputs. */
  acceptsImages?: boolean;
  /** Exact files outside rootPath that this agent may write. */
  writableExternalPaths?: readonly string[];
  /** Directory trees outside rootPath that this agent may write. */
  writableExternalDirectories?: readonly string[];
  /** Omitted: ordinary workspace policy. Empty: no built-in file writes are allowed. */
  writeScope?: readonly import("./path-safety.js").FileWriteScope[];
  signal: AbortSignal;
  /** Resources approved and reserved for this invocation. Absent for direct tool calls. */
  resources?: readonly ToolResourceClaim[];
  fileHistory?: import("../file-history/service.js").FileEditTracker;
  /** File versions whose results reached this execution's current model context. */
  fileReads?: import("./file-read-state.js").FileReadState;
  /** Per-execution observations and coordinated access to the configured memory file. */
  globalMemory?: import("../global-memory.js").GlobalMemoryAccess;
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

export interface AgentTool<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TPrepared extends Record<string, unknown> = TArgs,
> {
  name: string;
  description: string;
  parameters: TSchema;
  replay: "safe" | "never";
  /** Resolve effective arguments once, after schema validation and extension rewriting. No tool side effects. */
  prepare?(args: TArgs, context: ToolPlanningContext): TPrepared | Promise<TPrepared>;
  execution: ToolExecutionPolicy<TPrepared>;
  execute(args: TPrepared, context: ToolContext): Promise<ToolResult>;
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
