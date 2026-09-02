import { Type } from "@earendil-works/pi-ai";
import { noResources, singletonResource } from "../tools/execution.js";
import type { AgentTool, ToolContext, ToolResult } from "../tools/types.js";
import type { ImplementationTaskSpec } from "./model.js";
import type { AgentTaskOrchestrator } from "./orchestrator.js";

function ok(value: unknown): ToolResult {
  return { content: typeof value === "string" ? value : JSON.stringify(value, null, 2), isError: false };
}

function fail(error: unknown): ToolResult {
  return { content: error instanceof Error ? error.message : String(error), isError: true };
}

function ownTask(orchestrator: AgentTaskOrchestrator, taskId: string, context: ToolContext): void {
  const task = orchestrator.repository.projection.require(taskId);
  if (task.parentTurnId !== context.invocation.executionId) throw new Error(`Task ${taskId} does not belong to this turn`);
}

const scopeSchema = Type.Object({
  path: Type.String({ description: "Project-relative file or directory path." }),
  kind: Type.Union([Type.Literal("file"), Type.Literal("directory")]),
});

const specSchema = Type.Object({
  title: Type.String(),
  objective: Type.String(),
  guidance: Type.Array(Type.String(), { minItems: 1 }),
  acceptanceCriteria: Type.Array(Type.String(), { minItems: 1 }),
  writeScope: Type.Array(scopeSchema, { minItems: 1 }),
});

export function createAgentTaskTools(orchestrator: AgentTaskOrchestrator): AgentTool[] {
  const delegate: AgentTool<{ tasks: ImplementationTaskSpec[] }> = {
    name: "delegate_tasks",
    description: "Delegate one or two independent implementation tasks with non-overlapping write scopes. Workers edit the current project workspace directly, so their changes are immediately visible.",
    parameters: Type.Object({ tasks: Type.Array(specSchema, { minItems: 1, maxItems: 2 }) }),
    replay: "never",
    execution: { effect: "process", mode: "sequential", resources: () => noResources() },
    async execute(args, context) {
      try {
        const summaries = await orchestrator.delegate(args.tasks, {
          parentTurnId: context.invocation.executionId,
          toolCallId: context.invocation.toolCallId,
          signal: context.signal,
          ...(context.onUiEvent ? { ui: context.onUiEvent } : {}),
        });
        return ok({ tasks: summaries, note: "Workers are editing the shared workspace. Do not edit their write scopes while they run; inspect current files after they complete." });
      } catch (error) { return fail(error); }
    },
  };

  const wait: AgentTool<{ taskIds: string[]; returnWhen: "first" | "all" }> = {
    name: "wait_tasks",
    description: "Wait for the first or all delegated tasks to finish, returning status, resource usage, and each worker's final response.",
    parameters: Type.Object({
      taskIds: Type.Array(Type.String(), { minItems: 1 }),
      returnWhen: Type.Union([Type.Literal("first"), Type.Literal("all")]),
    }),
    replay: "never",
    execution: { effect: "process", mode: "sequential", resources: () => noResources() },
    async execute(args, context) {
      try {
        for (const id of args.taskIds) ownTask(orchestrator, id, context);
        return ok(await orchestrator.waitTasks(args.taskIds, args.returnWhen, context.signal));
      } catch (error) { return fail(error); }
    },
  };

  const revise: AgentTool<{ taskId: string; feedback: string }> = {
    name: "request_revision",
    description: "Continue a completed worker in the same shared workspace with concrete review feedback. The task specification and write scope remain fixed.",
    parameters: Type.Object({ taskId: Type.String(), feedback: Type.String() }),
    replay: "never",
    execution: { effect: "process", mode: "sequential", resources: (args) => singletonResource("agent-task", args.taskId, "write") },
    async execute(args, context) {
      try {
        ownTask(orchestrator, args.taskId, context);
        return ok(await orchestrator.requestRevision(args.taskId, args.feedback, context.signal, context.onUiEvent));
      } catch (error) { return fail(error); }
    },
  };

  const cancel: AgentTool<{ taskId: string; reason: string }> = {
    name: "cancel_task",
    description: "Interrupt a running task. Files already changed in the shared workspace are preserved and must be reviewed by the main agent.",
    parameters: Type.Object({ taskId: Type.String(), reason: Type.String() }),
    replay: "never",
    execution: { effect: "process", mode: "sequential", resources: (args) => singletonResource("agent-task", args.taskId, "write") },
    async execute(args, context) {
      try {
        ownTask(orchestrator, args.taskId, context);
        const summary = await orchestrator.cancelTask(args.taskId, args.reason, context.onUiEvent);
        return ok({ task: summary, note: "The worker was interrupted. Existing workspace changes were preserved and must be reviewed." });
      } catch (error) { return fail(error); }
    },
  };

  return [delegate, wait, revise, cancel];
}
