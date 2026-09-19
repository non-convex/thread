import type { AssistantMessage, Context, Usage } from "@earendil-works/pi-ai";
import { AgentStepRunner } from "../agent/step-runner.js";
import type { FileHistoryService } from "../file-history/service.js";
import { ToolCallExecutor } from "../agent/tool-call-executor.js";
import { ExtensionEvents } from "../extensions/events.js";
import { executionEventSink, safeExecutionEvent, type ExecutionEventSink } from "../runtime/events.js";
import { AgentTaskJournal } from "./journal.js";
import type { AgentProfile } from "../agent/profile.js";
import type { AgentTaskRun } from "./model.js";
import type { WorkerLimits } from "./profile.js";
import { taskSpecMessage } from "./prompt.js";
import type { AgentTaskRepository } from "./repository.js";
import type { HostExecutionOptions } from "../runtime/policy.js";

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function addUsage(total: Usage, usage: Usage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  total.cost.input += usage.cost.input;
  total.cost.output += usage.cost.output;
  total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite;
  total.cost.total += usage.cost.total;
  if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
}

function responseText(response: AssistantMessage): string {
  return response.content.filter((content) => content.type === "text").map((content) => content.text).join("\n").trim();
}

export class WorkerTaskRunner {
  constructor(
    private readonly repository: AgentTaskRepository,
    private readonly rootPath: string,
    private readonly fileHistory?: FileHistoryService,
    private readonly executionOptions: HostExecutionOptions = {},
  ) {}

  async run(
    taskId: string,
    profile: AgentProfile,
    limits: WorkerLimits,
    parentSignal: AbortSignal,
    ui?: ExecutionEventSink,
  ): Promise<void> {
    const task = this.repository.projection.require(taskId);
    const revision = task.runs.length;
    const startedAt = Date.now();
    const run: AgentTaskRun = { revision, startedAt };
    await this.repository.append({ type: "run_started", taskId, run }, true);
    this.updated(taskId, ui);

    const timeout = AbortSignal.timeout(limits.maxRuntimeMs);
    const signal = AbortSignal.any([parentSignal, timeout]);
    const journal = new AgentTaskJournal(this.repository, taskId, this.executionOptions.sessionIdForTurn?.(task.parentTurnId));
    const taskUi = executionEventSink(journal.identity, ui);
    if (journal.messages.length === 0) await journal.appendUser(taskSpecMessage(task.spec, this.rootPath));
    const toolRunner = new ToolCallExecutor(this.rootPath, profile.tools, new ExtensionEvents(), {
      ...(this.fileHistory ? { fileHistory: () => this.fileHistory!.forTurn(task.parentTurnId) } : {}),
      ...(this.executionOptions.toolPolicy ? { toolPolicy: this.executionOptions.toolPolicy } : {}),
      agentId: profile.id,
      writeScope: task.spec.writeScope,
    });
    const reasoning = profile.thinkingLevel === "off" ? undefined : profile.thinkingLevel;
    const stepRunner = new AgentStepRunner(profile.model, toolRunner, reasoning);
    const usage = emptyUsage();
    let finalResponse = "";
    safeExecutionEvent(taskUi, { type: "agent_run_started", input: taskSpecMessage(task.spec, this.rootPath), timestamp: startedAt });
    try {
      for (let step = 1; step <= limits.maxSteps; step++) {
        signal.throwIfAborted();
        const context: Context = {
          systemPrompt: profile.systemPrompt,
          messages: journal.messages,
          tools: profile.tools.modelDefinitions(),
        };
        const result = await stepRunner.run(context, journal, {
          signal,
          step,
          ...(taskUi ? { onUiEvent: taskUi } : {}),
        });
        addUsage(usage, result.response.usage);
        await this.repository.append({ type: "run_progress", taskId, revision, usage: structuredClone(usage) });
        this.updated(taskId, ui);
        finalResponse = responseText(result.response) || finalResponse;
        if (result.response.stopReason === "aborted") throw new DOMException(result.response.errorMessage ?? "Aborted", "AbortError");
        if (result.response.stopReason === "error") throw new Error(result.response.errorMessage ?? "Worker model request failed");
        if (result.calls.length === 0) break;
        if (step === limits.maxSteps) throw new Error(`Worker exceeded ${limits.maxSteps} model steps`);
      }
      signal.throwIfAborted();
      await this.repository.append({
        type: "run_finished",
        taskId,
        run: { revision, startedAt, finishedAt: Date.now(), outcome: "completed", usage, finalResponse },
      });
      await this.repository.append({ type: "status_changed", taskId, status: "completed" }, true);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const cancelled = parentSignal.aborted;
      const errorMessage = timeout.aborted && !parentSignal.aborted
        ? `Worker exceeded ${limits.maxRuntimeMs}ms runtime limit`
        : error.message;
      await this.repository.append({
        type: "run_finished",
        taskId,
        run: {
          revision,
          startedAt,
          finishedAt: Date.now(),
          outcome: cancelled ? "cancelled" : "failed",
          usage,
          finalResponse,
          error: errorMessage,
        },
      });
      await this.repository.append({
        type: "status_changed",
        taskId,
        status: cancelled ? "cancelled" : "failed",
        error: errorMessage,
        ...(cancelled ? { reason: String(parentSignal.reason ?? "Parent turn ended") } : {}),
      }, true);
    } finally {
      const settled = this.repository.projection.require(taskId).runs.at(-1)!;
      safeExecutionEvent(taskUi, { type: "agent_run_finished", outcome: settled.outcome ?? "failed", output: finalResponse,
        ...(settled.error ? { error: settled.error } : {}), timestamp: settled.finishedAt ?? Date.now() });
      this.updated(taskId, ui);
    }
  }

  private updated(taskId: string, ui?: ExecutionEventSink): void {
    safeExecutionEvent(ui, { type: "agent_task_updated", summary: this.repository.projection.summary(taskId) });
  }
}
