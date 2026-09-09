import type { CompactionEntry, SessionEntry, ToolExecutionEntry } from "../../core/session-tree/model.js";
import { userContentDisplay } from "../../core/session-tree/user-content.js";
import { AGENT_TASK_TOOL_NAMES, type AgentTask, type AgentTaskSummary } from "../../core/agent-task/model.js";
import type { AgentTaskCard, LiveBlock, LiveTurn, TranscriptItem } from "../state.js";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string; thinking?: string } =>
      typeof block === "object" && block !== null && "type" in block
    )
    .map((block) => block.type === "text" ? block.text ?? "" : block.type === "thinking" ? block.thinking ?? "" : "")
    .join("\n")
    .trim();
}

function summarizeArgs(args: Record<string, unknown>): string {
  const rendered = JSON.stringify(args);
  return rendered.length > 160 ? `${rendered.slice(0, 157)}…` : rendered;
}

function compactionEntryDetail(entry: CompactionEntry): string | undefined {
  const summaries = [entry.summary, entry.progressSummary ?? ""]
    .map((summary) => summary.trim())
    .filter(Boolean);
  return summaries.length > 0 ? summaries.join("\n\n---\n\n") : undefined;
}

export function projectLiveUser(turn: Pick<LiveTurn, "id" | "input">): TranscriptItem {
  return { id: `${turn.id}:user`, kind: "user", content: turn.input };
}

export interface AgentTaskHistoryProjection {
  task: AgentTask;
  summary: AgentTaskSummary;
}

function projectTask(input: AgentTaskHistoryProjection): AgentTaskCard {
  const { task } = input;
  const tools = new Map(task.trace.filter((entry) => entry.kind === "tool_execution").map((entry) => [entry.fact.toolCallId, entry.fact]));
  const trace: LiveBlock[] = [];
  for (const entry of task.trace) {
    if (entry.kind === "tool_execution" || entry.message.role === "user") continue;
    if (entry.message.role === "toolResult") {
      const fact = tools.get(entry.message.toolCallId);
      trace.push({
        id: entry.entryId,
        kind: "tool",
        content: textContent(entry.message.content),
        tool: {
          id: entry.message.toolCallId,
          name: fact?.toolName ?? entry.message.toolName,
          args: fact?.effectiveArgs ?? {},
          status: entry.message.isError ? "failed" : "completed",
          ...(entry.message.isError ? { error: textContent(entry.message.content) } : {}),
          startedAt: entry.timestamp,
          finishedAt: entry.timestamp,
        },
      });
      continue;
    }
    for (let index = 0; index < entry.message.content.length; index++) {
      const content = entry.message.content[index]!;
      if (content.type === "thinking" && content.thinking.trim()) {
        trace.push({ id: `${entry.entryId}:thinking:${index}`, kind: "thinking", content: content.thinking });
      }
      if (content.type === "text" && content.text.trim()) {
        trace.push({ id: `${entry.entryId}:text:${index}`, kind: "assistant", content: content.text });
      }
    }
  }
  return {
    summary: input.summary,
    trace,
  };
}

export function projectTranscript(entries: readonly SessionEntry[], tasks: readonly AgentTaskHistoryProjection[] = []): TranscriptItem[] {
  const tools = new Map<string, ToolExecutionEntry>();
  for (const entry of entries) if (entry.type === "tool_execution") tools.set(entry.toolCallId, entry);
  const tasksByAnchor = new Map<string, AgentTaskHistoryProjection[]>();
  for (const task of tasks) {
    const anchored = tasksByAnchor.get(task.task.toolCallId) ?? [];
    anchored.push(task);
    tasksByAnchor.set(task.task.toolCallId, anchored);
  }
  const output: TranscriptItem[] = [];
  for (const entry of entries) {
    if (entry.type === "file_edit") continue;
    if (entry.type === "tool_execution") {
      for (const task of tasksByAnchor.get(entry.toolCallId) ?? []) {
        output.push({ id: `agent-task:${task.task.id}`, kind: "agent_task", content: "", agentTask: projectTask(task) });
      }
      continue;
    }
    if (entry.type === "compaction") {
      const detail = compactionEntryDetail(entry);
      output.push({
        id: entry.id,
        kind: "compaction",
        content: `context compacted · ${entry.reason}`,
        ...(detail ? { detail } : {}),
      });
      continue;
    }
    const message = entry.message;
    if (message.role === "user") {
      output.push({ id: entry.id, kind: "user", content: userContentDisplay(message.content) });
      continue;
    }
    if (message.role === "toolResult") {
      const started = tools.get(message.toolCallId);
      if (AGENT_TASK_TOOL_NAMES.has(started?.toolName ?? message.toolName)) continue;
      output.push({
        id: entry.id,
        kind: "tool",
        content: textContent(message.content),
        name: started?.toolName ?? message.toolName,
        ...(started ? { args: summarizeArgs(started.effectiveArgs) } : {}),
        isError: message.isError,
      });
      continue;
    }
    for (let index = 0; index < message.content.length; index++) {
      const block = message.content[index]!;
      if (block.type === "thinking" && block.thinking.trim()) {
        output.push({ id: `${entry.id}:thinking:${index}`, kind: "thinking", content: block.thinking });
      }
      if (block.type === "text" && block.text.trim()) {
        output.push({ id: `${entry.id}:text:${index}`, kind: "assistant", content: block.text });
      }
    }
  }
  return output;
}

export interface TranscriptTurnGroup {
  id: string;
  user: TranscriptItem | undefined;
  items: TranscriptItem[];
}

export function groupTranscriptTurns(items: readonly TranscriptItem[]): TranscriptTurnGroup[] {
  const groups: TranscriptTurnGroup[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      groups.push({ id: item.id, user: item, items: [] });
      continue;
    }
    const last = groups.at(-1);
    if (last) last.items.push(item);
    else groups.push({ id: item.id, user: undefined, items: [item] });
  }
  return groups;
}

function sameTranscriptItem(left: TranscriptItem, right: TranscriptItem): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.content === right.content
    && left.isError === right.isError
    && left.name === right.name
    && left.args === right.args
    && left.elapsed === right.elapsed
    && left.label === right.label
    && left.detail === right.detail
    && JSON.stringify(left.agentTask) === JSON.stringify(right.agentTask);
}

function sameTurnGroup(left: TranscriptTurnGroup, right: TranscriptTurnGroup): boolean {
  if (left.id !== right.id) return false;
  if ((left.user === undefined) !== (right.user === undefined)) return false;
  if (left.user && right.user && !sameTranscriptItem(left.user, right.user)) return false;
  if (left.items.length !== right.items.length) return false;
  return left.items.every((item, index) => sameTranscriptItem(item, right.items[index]!));
}

// Preserve unchanged group identities so Solid keeps completed markdown rows mounted.
export function reconcileTurnGroups(
  next: readonly TranscriptTurnGroup[],
  previous: readonly TranscriptTurnGroup[],
): TranscriptTurnGroup[] {
  if (previous.length === 0) return [...next];
  const byId = new Map(previous.map((group) => [group.id, group] as const));
  return next.map((group) => {
    const earlier = byId.get(group.id);
    return earlier && sameTurnGroup(group, earlier) ? earlier : group;
  });
}
