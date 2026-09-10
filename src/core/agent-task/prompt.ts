import { fileEditingPrompt } from "../tools/file-editing-prompt.js";
import type { WorkerTaskSpec } from "./model.js";

export function workerSystemPrompt(fileCheckpoints = true): string {
  return `You are a worker sharing the current project workspace with the main agent and other workers.

${fileEditingPrompt(fileCheckpoints)}

Implement only the assigned task. Your file changes are immediately visible to everyone. Inspect the relevant code before editing, follow the supplied guidance and acceptance criteria, and stay within the declared write scope. Do not undo, overwrite, or reorganize unrelated work; assume other agents may be editing outside your scope. Do not delegate, ask the user questions, or use Git commands that change repository state. If the task cannot be completed safely within its boundaries, explain the blocker instead of expanding scope.

In your final response, briefly state what you completed, which files you changed, and any unfinished work or blockers. Include verification results only when verification was performed.`;
}

export const WORKER_SYSTEM_PROMPT = workerSystemPrompt();

export const AGENT_TASK_ORCHESTRATION_PROMPT = `Delegate only substantial, independent leaf implementation tasks with non-overlapping write scopes and clear acceptance criteria. Handle simple lookups and small edits yourself. Workers cannot see this conversation: put known file locations, agreed interfaces and design decisions, the user's current constraints, and the remaining work in guidance. Establish shared architecture and public interfaces before delegating. Workers edit the current project workspace directly. While they run, work outside their write scopes and do not repeat their assigned work.

Wait only when you need a result. If wait_tasks times out, the workers remain active; continue other work or wait again for the running task IDs. There is no apply step: completed worker changes are already present. Review the current files and any reported unfinished work; a completed run does not guarantee the acceptance criteria were met. Request a concrete revision when needed. A cancelled or failed worker may have left partial changes that you must inspect. Create dependent tasks only after their dependency completes. Before ending the turn, wait for or cancel every running task.`;

export function taskSpecMessage(spec: WorkerTaskSpec, rootPath: string): string {
  const lines = [
    `Task: ${spec.title}`,
    "",
    `Objective: ${spec.objective}`,
    "",
    "Guidance:",
    ...spec.guidance.map((item) => `- ${item}`),
    "",
    "Acceptance criteria:",
    ...spec.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "Write scope:",
    ...spec.writeScope.map((scope) => `- ${scope.kind}: ${scope.path}`),
    "",
    `Shared workspace root: ${rootPath}`,
    `Runtime platform: ${process.platform} (${process.arch})`,
  ];
  return lines.join("\n");
}
