import { Type } from "@earendil-works/pi-ai";
import { BUILTIN_TOOL_NAMES } from "../tools/builtins.js";
import { noResources, singletonResource } from "../tools/execution.js";
import type { AgentTool, ToolContext, ToolResult } from "../tools/types.js";
import type { WorkerTaskSpec } from "./model.js";
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
  objective: Type.String({ description: "The concrete task to implement, investigate, search, review, or otherwise complete." }),
  guidance: Type.Array(Type.String(), { minItems: 1, description: "Relevant background, known files or sources, agreed interfaces and decisions, current user constraints, and the expected result. The worker cannot see the main conversation." }),
  acceptanceCriteria: Type.Array(Type.String(), { minItems: 1, description: "Conditions for a satisfactory result. For investigations, specify what must be answered and what evidence is sufficient." }),
  tools: Type.Array(Type.Union(BUILTIN_TOOL_NAMES.map((name) => Type.Literal(name))), {
    uniqueItems: true,
    description: "Built-in tools available to this task and its revisions. Names must be unique; [] gives no tools. Bash can modify files and is not constrained by writeScope.",
  }),
  writeScope: Type.Array(scopeSchema, { description: "Allowed file changes. Use [] when no file changes are intended; assigning write or edit requires a non-empty scope. Enforced for built-in file writes, not arbitrary bash commands." }),
});

export function createAgentTaskTools(orchestrator: AgentTaskOrchestrator): AgentTool[] {
  const delegate: AgentTool<{ tasks: WorkerTaskSpec[] }> = {
    name: "delegate_tasks",
    description: "Delegate one or two self-contained tasks with individually selected tools. Workers share the current project workspace; any file changes are immediately visible and declared write scopes must not overlap.",
    parameters: Type.Object({ tasks: Type.Array(specSchema, { minItems: 1, maxItems: 2 }) }),

    execution: { effect: "process", mode: "sequential", resources: () => noResources() },
    async execute(args, context) {
      try {
        const summaries = await orchestrator.delegate(args.tasks, {
          parentTurnId: context.invocation.executionId,
          toolCallId: context.invocation.toolCallId,
          signal: context.signal,
          ...(context.onExecutionEvent ? { ui: context.onExecutionEvent } : {}),
        });
        return ok({ tasks: summaries, note: "Workers are running in the shared workspace with their assigned tools. Do not duplicate their work or edit their write scopes while they run; review their findings and any file changes after they complete." });
      } catch (error) { return fail(error); }
    },
  };

  const wait: AgentTool<{ taskIds: string[]; returnWhen: "first" | "all"; timeoutMs?: number }> = {
    name: "wait_tasks",
    description: "Wait for the first or all delegated tasks to finish. Returns { tasks, timedOut } with status, usage, and final responses. A timeout leaves workers running. To wait for further progress, pass only running task IDs.",
    parameters: Type.Object({
      taskIds: Type.Array(Type.String(), { minItems: 1 }),
      returnWhen: Type.Union([Type.Literal("first"), Type.Literal("all")]),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647, description: "Maximum time to wait in milliseconds. Default: 60000. Does not change worker runtime limits." })),
    }),
    execution: { effect: "process", mode: "sequential", resources: () => noResources() },
    async execute(args, context) {
      try {
        for (const id of args.taskIds) ownTask(orchestrator, id, context);
        return ok(await orchestrator.waitTasks(args.taskIds, args.returnWhen, context.signal, args.timeoutMs));
      } catch (error) { return fail(error); }
    },
  };

  const revise: AgentTool<{ taskId: string; feedback: string }> = {
    name: "request_revision",
    description: "Continue a completed worker in the same shared workspace with concrete feedback. The task specification, assigned tools, and write scope remain fixed.",
    parameters: Type.Object({ taskId: Type.String(), feedback: Type.String() }),

    execution: { effect: "process", mode: "sequential", resources: (args) => singletonResource("agent-task", args.taskId, "write") },
    async execute(args, context) {
      try {
        ownTask(orchestrator, args.taskId, context);
        return ok(await orchestrator.requestRevision(args.taskId, args.feedback, context.signal, context.onExecutionEvent));
      } catch (error) { return fail(error); }
    },
  };

  const cancel: AgentTool<{ taskId: string; reason: string }> = {
    name: "cancel_task",
    description: "Interrupt a running task. Files already changed in the shared workspace are preserved and must be reviewed by the main agent.",
    parameters: Type.Object({ taskId: Type.String(), reason: Type.String() }),

    execution: { effect: "process", mode: "sequential", resources: (args) => singletonResource("agent-task", args.taskId, "write") },
    async execute(args, context) {
      try {
        ownTask(orchestrator, args.taskId, context);
        const summary = await orchestrator.cancelTask(args.taskId, args.reason);
        return ok({ task: summary, note: "The worker was interrupted. Existing workspace changes were preserved and must be reviewed." });
      } catch (error) { return fail(error); }
    },
  };

  return [delegate, wait, revise, cancel];
}
