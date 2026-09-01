import { Type } from "@earendil-works/pi-ai";
import { entireWorkspaceClaim, noResources, singletonResource } from "../tools/execution.js";
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
  path: Type.String({ description: "Project-relative file or subtree path." }),
  kind: Type.Union([Type.Literal("file"), Type.Literal("subtree")]),
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
    description: "Delegate one or two independent, non-overlapping implementation tasks to isolated implementation workers. Provide detailed guidance and mechanically checkable acceptance criteria.",
    parameters: Type.Object({ tasks: Type.Array(specSchema, { minItems: 1, maxItems: 2 }) }),
    replay: "never",
    execution: { effect: "process", mode: "sequential", resources: () => [entireWorkspaceClaim("read")] },
    async execute(args, context) {
      try {
        const summaries = await orchestrator.delegate(args.tasks, {
          parentTurnId: context.invocation.executionId,
          toolCallId: context.invocation.toolCallId,
          signal: context.signal,
          ...(context.onUiEvent ? { ui: context.onUiEvent } : {}),
        });
        return ok({ tasks: summaries, note: "Workers are running in the background. Continue independent work or call wait_tasks when their results are needed." });
      } catch (error) { return fail(error); }
    },
  };

  const wait: AgentTool<{ taskIds: string[]; returnWhen: "first" | "all" }> = {
    name: "wait_tasks",
    description: "Wait for delegated tasks only when the next decision depends on their results.",
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

  const inspect: AgentTool<{ taskId: string; view: "summary" | "diff" | "trace"; path?: string; cursor?: number; limit?: number; fullTrace?: boolean }> = {
    name: "inspect_task",
    description: "Inspect a task summary, its mechanical workspace diff, or its child trace. Diff and trace output are cursor-paginated.",
    parameters: Type.Object({
      taskId: Type.String(),
      view: Type.Union([Type.Literal("summary"), Type.Literal("diff"), Type.Literal("trace")]),
      path: Type.Optional(Type.String()),
      cursor: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 64_000 })),
      fullTrace: Type.Optional(Type.Boolean({ description: "For trace view only: return full child messages instead of structured previews." })),
    }),
    replay: "safe",
    execution: { effect: "read", mode: "parallel", resources: (args) => singletonResource("agent-task", args.taskId, "read") },
    async execute(args, context) {
      try {
        ownTask(orchestrator, args.taskId, context);
        const result = await orchestrator.inspect(args.taskId, args.view, args);
        return ok(`${result.content}${result.nextCursor === undefined ? "" : `\n\n[next cursor: ${result.nextCursor}]`}`);
      } catch (error) { return fail(error); }
    },
  };

  const revise: AgentTool<{ taskId: string; feedback: string }> = {
    name: "request_revision",
    description: "Continue the same worker, sandbox, and child context with concrete review feedback. The task specification and write scope remain fixed.",
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

  const apply: AgentTool<{ taskId: string; changeSetId: string }> = {
    name: "apply_task",
    description: "Transactionally apply the latest reviewed ChangeSet after conservative three-way conflict checking. Inspect the full diff first.",
    parameters: Type.Object({ taskId: Type.String(), changeSetId: Type.String() }),
    replay: "never",
    execution: { effect: "write", mode: "sequential", resources: () => [entireWorkspaceClaim("write")] },
    async execute(args, context) {
      try {
        ownTask(orchestrator, args.taskId, context);
        const result = await orchestrator.applyTask(args.taskId, args.changeSetId, context.onUiEvent);
        return result.conflicts.length
          ? { content: `ChangeSet was not applied because of conflicts:\n${result.conflicts.join("\n")}`, isError: true }
          : ok(result.summary);
      } catch (error) { return fail(error); }
    },
  };

  const cancel: AgentTool<{ taskId: string; reason: string }> = {
    name: "cancel_task",
    description: "Cancel a running task or discard an unmerged task that is awaiting review.",
    parameters: Type.Object({ taskId: Type.String(), reason: Type.String() }),
    replay: "never",
    execution: { effect: "process", mode: "sequential", resources: (args) => singletonResource("agent-task", args.taskId, "write") },
    async execute(args, context) {
      try {
        ownTask(orchestrator, args.taskId, context);
        return ok(await orchestrator.cancelTask(args.taskId, args.reason, context.onUiEvent));
      } catch (error) { return fail(error); }
    },
  };

  return [delegate, wait, inspect, revise, apply, cancel];
}
