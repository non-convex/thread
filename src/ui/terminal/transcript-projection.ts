import type { Message, ToolCall } from "@earendil-works/pi-ai";
import type { CompactionEntry, SessionEntry } from "../../core/session-tree/model.js";
import type { ToolExecutionFact } from "../../core/agent/execution-journal.js";
import type { ToolResultMetadata } from "../../core/tools/types.js";
import { userContentDisplay } from "../../core/session-tree/user-content.js";
import { AGENT_TASK_TOOL_NAMES, type AgentTask, type AgentTaskSummary } from "../../core/agent-task/model.js";
import type { AgentTaskCard, LiveBlock, LiveTurn, TranscriptItem } from "../state.js";

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => block?.type === "text" ? [block.text] : block?.type === "thinking" ? [block.thinking] : []).join("\n");
}

function compactionEntryDetail(entry: CompactionEntry): string | undefined {
  const summaries = [entry.summary, entry.progressSummary ?? ""].map((summary) => summary.trim()).filter(Boolean);
  return summaries.length > 0 ? summaries.join("\n\n---\n\n") : undefined;
}

export function projectLiveUser(turn: Pick<LiveTurn, "id" | "input">): TranscriptItem {
  return { id: `${turn.id}:user`, kind: "user", content: turn.input };
}

export interface AgentTaskHistoryProjection {
  task: AgentTask;
  summary: AgentTaskSummary;
}

type ToolMessage = Extract<Message, { role: "toolResult" }>;

function projectTool(message: ToolMessage, fact?: ToolExecutionFact, call?: ToolCall): LiveBlock {
  const metadata = message.details as Partial<ToolResultMetadata> | undefined;
  return {
    id: `tool:${message.toolCallId}`,
    kind: "tool",
    content: textContent(message.content),
    tool: {
      id: message.toolCallId,
      name: fact?.toolName ?? message.toolName,
      args: fact?.effectiveArgs ?? call?.arguments ?? {},
      status: metadata?.outcome ?? (message.isError ? "failed" : "completed"),
      ...(metadata?.raw?.details !== undefined ? { details: metadata.raw.details } : {}),
      ...(metadata?.durationMs !== undefined ? { durationMs: metadata.durationMs } : {}),
    },
  };
}

/** Tools stay at their call position, even when concurrent results finish in another order. */
function messageBlocks(
  message: Message, entryId: string, tool: (id: string, call?: ToolCall) => LiveBlock[], finalResponse = false,
): LiveBlock[] {
  if (message.role === "toolResult") return tool(message.toolCallId);
  if (message.role === "user") return [{ id: entryId, kind: "user", content: userContentDisplay(message.content) }];
  if (message.role !== "assistant") return [];
  const copyable = finalResponse && (message.stopReason === "stop" || message.stopReason === "length") &&
    !message.content.some((block) => block.type === "toolCall");
  const lastText = copyable ? message.content.findLastIndex((block) => block.type === "text" && block.text.trim()) : -1;
  const replyCopyContent = copyable
    ? message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n\n") : "";
  return message.content.flatMap((block, index): LiveBlock[] => {
    if (block.type === "toolCall") return tool(block.id, block);
    if (block.type === "thinking" && block.thinking.trim()) {
      return [{ id: `${entryId}:thinking:${index}`, kind: "thinking", content: block.thinking }];
    }
    if (block.type === "text" && block.text.trim()) {
      return [{ id: `${entryId}:text:${index}`, kind: "assistant", content: block.text,
        ...(index === lastText ? { replyCopyContent } : {}) }];
    }
    return [];
  });
}

function projectTask(input: AgentTaskHistoryProjection): AgentTaskCard {
  const { task } = input;
  // Each task input / revision starts an exchange, just as a user turn does in
  // the main transcript. Keep the final reply of every exchange copyable.
  const finalAssistantIds = new Set<string>();
  let finalAssistantId: string | undefined;
  for (const entry of task.trace) {
    if (entry.kind !== "message") continue;
    if (entry.message.role === "user") {
      if (finalAssistantId) finalAssistantIds.add(finalAssistantId);
      finalAssistantId = undefined;
    } else if (entry.message.role === "assistant") finalAssistantId = entry.entryId;
  }
  if (finalAssistantId) finalAssistantIds.add(finalAssistantId);
  const facts = new Map(task.trace.filter((entry) => entry.kind === "tool_execution").map((entry) => [entry.fact.toolCallId, entry.fact]));
  const results = new Map(task.trace.flatMap((entry) => entry.kind !== "tool_execution" && entry.message.role === "toolResult"
    ? [[entry.message.toolCallId, entry.message] as const] : []));
  const rendered = new Set<string>();
  const tool = (id: string, call?: ToolCall): LiveBlock[] => {
    const result = results.get(id);
    if (!result || rendered.has(id)) return [];
    rendered.add(id);
    return [projectTool(result, facts.get(id), call)];
  };
  return {
    summary: input.summary,
    trace: task.trace.flatMap((entry) => entry.kind === "tool_execution"
      ? [] : messageBlocks(entry.message, entry.entryId, tool, finalAssistantIds.has(entry.entryId))),
  };
}

export function projectTranscript(entries: readonly SessionEntry[], tasks: readonly AgentTaskHistoryProjection[] = []): TranscriptItem[] {
  const finalAssistantIds = new Map(entries.flatMap((entry) => entry.type === "message" && entry.message.role === "assistant"
    ? [[entry.turnId, entry.id] as const] : []));
  const facts = new Map(entries.filter((entry) => entry.type === "tool_execution").map((entry) => [entry.toolCallId, entry]));
  const results = new Map(entries.flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult"
    ? [[entry.message.toolCallId, entry.message] as const] : []));
  const tasksByAnchor = new Map<string, AgentTaskHistoryProjection[]>();
  for (const task of tasks) {
    const anchored = tasksByAnchor.get(task.task.toolCallId) ?? [];
    anchored.push(task);
    tasksByAnchor.set(task.task.toolCallId, anchored);
  }
  const rendered = new Set<string>();
  const tool = (id: string, call?: ToolCall): LiveBlock[] => {
    if (rendered.has(id)) return [];
    rendered.add(id);
    const children = tasksByAnchor.get(id);
    if (children) return children.map((task) => ({
      id: `agent-task:${task.task.id}`, kind: "agent_task", content: "", agentTask: projectTask(task),
    }));
    const result = results.get(id);
    if (!result || AGENT_TASK_TOOL_NAMES.has(facts.get(id)?.toolName ?? result.toolName)) return [];
    return [projectTool(result, facts.get(id), call)];
  };
  const output: TranscriptItem[] = [];
  for (const entry of entries) {
    if (entry.type === "file_edit" || entry.type === "tool_execution") continue;
    if (entry.type === "compaction") {
      const detail = compactionEntryDetail(entry);
      output.push({ id: `compaction:${entry.id}`, kind: "compaction", content: `context compacted · ${entry.reason}`,
        ...(detail ? { detail } : {}) });
    } else if (entry.message.role === "user") {
      output.push({ id: `${entry.turnId}:user`, kind: "user", content: userContentDisplay(entry.message.content) });
    } else {
      output.push(...messageBlocks(entry.message, entry.id, tool, finalAssistantIds.get(entry.turnId) === entry.id));
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
