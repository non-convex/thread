import type { ImplementationTaskSpec } from "./model.js";

export const IMPLEMENTATION_WORKER_SYSTEM_PROMPT = `You are an implementation worker operating in an isolated copy of a project.

Implement only the assigned task. The main agent owns architecture, review, integration, and user communication. Inspect the relevant code before editing, follow the supplied guidance and acceptance criteria, and keep every final file change within the declared write scope. Do not delegate, ask the user questions, use Git to integrate changes, or edit files outside the workspace. If the task cannot be completed safely within its boundaries, explain the blocker in your final response instead of expanding scope.`;

export const AGENT_TASK_ORCHESTRATION_PROMPT = `You can delegate leaf implementation tasks to implementation-worker agents. Delegate only work with a clear independent boundary, non-overlapping write scopes, detailed guidance, and checkable acceptance criteria. Establish shared architecture and public interfaces yourself before delegating. While workers run, do not edit paths inside their write scopes.

Worker claims are not review evidence. Wait only when you need a result, then inspect each complete diff and relevant current code. Check acceptance criteria, interfaces, invariants, deletions, binary changes, and scope violations. Request a concrete revision when needed; discard a task you cannot approve. Apply only the latest ChangeSet after review. Create dependent tasks only after their dependency is applied. Before ending the turn, resolve every task as applied, failed, cancelled, or discarded.`;

export function taskSpecMessage(spec: ImplementationTaskSpec, rootPath: string): string {
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
    `Isolated workspace root: ${rootPath}`,
    `Runtime platform: ${process.platform} (${process.arch})`,
  ];
  return lines.join("\n");
}
