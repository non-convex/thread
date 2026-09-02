import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import type { ModelClient, ModelRequestOptions } from "../src/agent/model-client.js";
import { AgentTaskOrchestrator } from "../src/agent-task/orchestrator.js";
import { AgentProfileRegistry, createImplementationWorkerProfile } from "../src/agent-task/profile.js";
import { AgentTaskRepository } from "../src/agent-task/repository.js";
import type { Project } from "../src/project/model.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function fixture(prefix: string): Promise<{ project: Project; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const rootPath = path.join(directory, "project");
  const statePath = path.join(directory, "thread-state");
  await Promise.all([mkdir(rootPath, { recursive: true }), mkdir(statePath, { recursive: true })]);
  return {
    project: { id: "project_agent_task_test", rootPath, statePath },
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

function profile(model: ModelClient) {
  return createImplementationWorkerProfile(model, {
    thinkingLevel: "off",
    limits: { maxConcurrent: 2, maxSteps: 5, maxRuntimeMs: 10_000, maxRevisions: 2 },
  });
}

function taskSpec(path: string) {
  return {
    title: `write ${path}`,
    objective: `Write ${path}`,
    guidance: ["Use the write tool."],
    acceptanceCriteria: ["The requested content exists."],
    writeScope: [{ path, kind: "file" as const }],
  };
}

test("worker and revision edit the same shared workspace", async (t) => {
  const values = await fixture("thread-agent-task-shared-");
  const repository = await AgentTaskRepository.open(values.project);
  let calls = 0;
  const model: ModelClient = {
    providerId: "test",
    modelId: "worker",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    reasoning: false,
    async stream(_context: Context, _options: ModelRequestOptions): Promise<AssistantMessage> {
      calls++;
      if (calls === 1) return fauxAssistantMessage(fauxToolCall("write", { path: "shared.txt", content: "first\n" }, { id: "write-first" }), { stopReason: "toolUse" });
      if (calls === 3) return fauxAssistantMessage(fauxToolCall("write", { path: "shared.txt", content: "revised\n" }, { id: "write-revised" }), { stopReason: "toolUse" });
      return fauxAssistantMessage(fauxText(calls === 2 ? "Changed shared.txt; verification: initial." : "Changed shared.txt; verification: revised."));
    },
  };
  const orchestrator = new AgentTaskOrchestrator(repository, new AgentProfileRegistry([profile(model)]), values.project.rootPath);
  t.after(async () => {
    await orchestrator.close().catch(() => undefined);
    await values.cleanup();
  });

  const parent = new AbortController();
  const [started] = await orchestrator.delegate([taskSpec("shared.txt")], {
    parentTurnId: "turn",
    toolCallId: "delegate",
    signal: parent.signal,
  });
  const [completed] = await orchestrator.waitTasks([started!.taskId], "all", parent.signal);
  assert.equal(completed!.summary.status, "completed");
  assert.match(completed!.finalResponse ?? "", /initial/);
  assert.equal(await readFile(path.join(values.project.rootPath, "shared.txt"), "utf8"), "first\n");

  await orchestrator.requestRevision(started!.taskId, "Replace the content with revised.", parent.signal);
  const [revised] = await orchestrator.waitTasks([started!.taskId], "all", parent.signal);
  assert.equal(revised!.summary.status, "completed");
  assert.equal(revised!.summary.revision, 1);
  assert.equal(await readFile(path.join(values.project.rootPath, "shared.txt"), "utf8"), "revised\n");
});

test("overlapping tasks are rejected and cancellation preserves written files", async (t) => {
  const values = await fixture("thread-agent-task-cancel-");
  const repository = await AgentTaskRepository.open(values.project);
  const blocked = deferred<void>();
  let calls = 0;
  const model: ModelClient = {
    providerId: "test",
    modelId: "blocking-worker",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    reasoning: false,
    async stream(_context: Context, options: ModelRequestOptions): Promise<AssistantMessage> {
      calls++;
      if (calls === 1) {
        return fauxAssistantMessage(fauxToolCall("write", { path: "partial.txt", content: "kept\n" }, { id: "write-partial" }), { stopReason: "toolUse" });
      }
      blocked.resolve();
      await new Promise<void>((resolve) => {
        if (options.signal.aborted) resolve();
        else options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage(fauxText("cancelled"), { stopReason: "aborted" });
    },
  };
  const orchestrator = new AgentTaskOrchestrator(repository, new AgentProfileRegistry([profile(model)]), values.project.rootPath);
  t.after(async () => {
    await orchestrator.close().catch(() => undefined);
    await values.cleanup();
  });

  const parent = new AbortController();
  const [started] = await orchestrator.delegate([taskSpec("partial.txt")], {
    parentTurnId: "turn",
    toolCallId: "delegate",
    signal: parent.signal,
  });
  await blocked.promise;
  await assert.rejects(
    orchestrator.delegate([taskSpec("partial.txt")], {
      parentTurnId: "turn",
      toolCallId: "overlap",
      signal: parent.signal,
    }),
    /overlaps running task/,
  );
  const cancelled = await orchestrator.cancelTask(started!.taskId, "stop now");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(await readFile(path.join(values.project.rootPath, "partial.txt"), "utf8"), "kept\n");
  await assert.rejects(orchestrator.cancelTask(started!.taskId, "again"), /does not revert workspace changes/);
});

test("v1 Agent Task history is rejected instead of migrated", async (t) => {
  const values = await fixture("thread-agent-task-v1-");
  t.after(values.cleanup);
  const taskStatePath = path.join(values.project.statePath, "agent-tasks");
  await mkdir(taskStatePath, { recursive: true });
  await writeFile(path.join(taskStatePath, "events.jsonl"), `${JSON.stringify({
    format: "thread-agent-task-v1",
    formatVersion: 1,
    sequence: 1,
    timestamp: 1,
    type: "task_created",
    task: {},
  })}\n`);

  await assert.rejects(AgentTaskRepository.open(values.project), /Unsupported Agent Task record/);
});
