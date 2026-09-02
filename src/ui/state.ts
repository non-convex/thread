import type { ModelDescriptor } from "../agent/model-client.js";
import type { EphemeralView, HistoryViewItem } from "../commands/types.js";
import type { ToolResult } from "../tools/types.js";
import type { AskRequest } from "./ask.js";
import type { UiEvent } from "./events.js";
import { AGENT_TASK_TOOL_NAMES, type AgentTaskSummary } from "../agent-task/model.js";

export interface TranscriptItem {
  id: string;
  kind: "user" | "assistant" | "thinking" | "tool" | "compaction" | "agent_task";
  content: string;
  label?: string;
  isError?: boolean;
  name?: string;
  args?: string;
  elapsed?: string;
  agentTask?: AgentTaskCard;
}

export interface AgentTaskCard {
  summary: AgentTaskSummary;
  trace: LiveBlock[];
}

export interface LiveTool {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "queued" | "running" | "completed" | "failed";
  result?: ToolResult;
  startedAt: number;
  finishedAt?: number;
}

export interface LiveBlock {
  id: string;
  kind: "thinking" | "assistant" | "tool" | "compaction" | "agent_task";
  content: string;
  streaming?: boolean;
  tool?: LiveTool;
  startedAt?: number;
  finishedAt?: number;
  agentTask?: AgentTaskCard;
}

export interface LiveTurn {
  id: string;
  input: string;
  sessionId: string;
  blocks: LiveBlock[];
  startedAt: number;
}

export interface ModelPickerScreen {
  type: "model_picker";
  target: "main" | "implementation-worker";
  models: ModelDescriptor[];
  currentProviderId: string | undefined;
  currentModelId: string | undefined;
  scope: "configured" | "all";
  selected: number;
  busy: boolean;
  error: string | undefined;
}

export interface SubagentSettingsScreen {
  type: "subagent_settings";
  enabled: boolean;
  selected: number;
  busy: boolean;
  error: string | undefined;
}

export interface RewindScreen {
  type: "rewind";
  items: HistoryViewItem[];
  selected: number;
  confirm: boolean;
  busy: boolean;
  error: string | undefined;
}

export interface AskScreen {
  type: "ask";
  request: AskRequest;
  questionIndex: number;
  chosen: number[][];
  selected: number;
  customText: string | undefined;
}

export type UiScreen =
  | { type: "session" }
  | { type: "document"; title: string; content: string }
  | ModelPickerScreen
  | SubagentSettingsScreen
  | RewindScreen
  | AskScreen;

export interface UiState {
  screen: UiScreen;
  transcript: TranscriptItem[];
  liveTurn: LiveTurn | undefined;
  busy: boolean;
  activity: string | undefined;
  notice: { level: "info" | "success" | "error"; text: string } | undefined;
  sessionId: string;
  liveTipTurnId: string | null;
}

export function createUiState(sessionId: string, liveTipTurnId: string | null, transcript: TranscriptItem[]): UiState {
  return {
    screen: { type: "session" },
    transcript,
    liveTurn: undefined,
    busy: false,
    activity: undefined,
    notice: undefined,
    sessionId,
    liveTipTurnId,
  };
}

export function openEphemeralView(state: UiState, view: EphemeralView): void {
  if (view.type === "document") state.screen = { type: "document", title: view.title, content: view.content };
  if (view.type === "model_picker") {
    const current = view.models.findIndex((model) =>
      model.providerId === view.currentProviderId && model.modelId === view.currentModelId
    );
    state.screen = {
      type: "model_picker",
      target: view.target,
      models: view.models,
      currentProviderId: view.currentProviderId,
      currentModelId: view.currentModelId,
      scope: view.scope,
      selected: current >= 0 ? current : 0,
      busy: false,
      error: undefined,
    };
  }
  if (view.type === "subagent_settings") {
    state.screen = {
      type: "subagent_settings",
      enabled: view.enabled,
      selected: view.enabled ? 1 : 0,
      busy: false,
      error: undefined,
    };
  }
  if (view.type === "rewind") {
    state.screen = {
      type: "rewind",
      items: view.items,
      selected: 0,
      confirm: false,
      busy: false,
      error: undefined,
    };
  }
}

function inFlightToolActivity(live: LiveTurn | undefined): string {
  const names = live?.blocks
    .filter((block) => block.tool?.status === "queued" || block.tool?.status === "running")
    .map((block) => block.tool!.name) ?? [];
  if (names.length === 0) return "thinking";
  if (names.length === 1) return names[0]!;
  const unique = [...new Set(names)];
  if (unique.length === 1) return `${unique[0]} ×${names.length}`;
  if (unique.length <= 3) return unique.join(" · ");
  return `${unique[0]} · ${unique[1]} +${unique.length - 2}`;
}

function endStreaming(live: LiveTurn): LiveTurn {
  const last = live.blocks.at(-1);
  if (!last?.streaming) return live;
  return { ...live, blocks: [...live.blocks.slice(0, -1), { ...last, streaming: false, finishedAt: Date.now() }] };
}

function appendLiveText(live: LiveTurn, kind: "thinking" | "assistant", delta: string): LiveTurn {
  if (!delta) return live;
  const last = live.blocks.at(-1);
  if (last?.kind === kind && last.streaming) {
    return { ...live, blocks: [...live.blocks.slice(0, -1), { ...last, content: last.content + delta }] };
  }
  const closed = endStreaming(live);
  return {
    ...closed,
    blocks: [...closed.blocks, {
      id: `${kind}:${closed.blocks.length + 1}`,
      kind,
      content: delta,
      streaming: true,
      startedAt: Date.now(),
    }],
  };
}

function taskTraceText(card: AgentTaskCard, kind: "thinking" | "assistant", delta: string): AgentTaskCard {
  if (!delta) return card;
  const last = card.trace.at(-1);
  if (last?.kind === kind && last.streaming) {
    return { ...card, trace: [...card.trace.slice(0, -1), { ...last, content: last.content + delta }] };
  }
  const trace = last?.streaming
    ? [...card.trace.slice(0, -1), { ...last, streaming: false, finishedAt: Date.now() }]
    : card.trace;
  return {
    ...card,
    trace: [...trace, { id: `${kind}:${trace.length + 1}`, kind, content: delta, streaming: true, startedAt: Date.now() }],
  };
}

function updateTaskCard(state: UiState, taskId: string, update: (card: AgentTaskCard) => AgentTaskCard): void {
  if (state.liveTurn) {
    state.liveTurn = {
      ...state.liveTurn,
      blocks: state.liveTurn.blocks.map((block) => block.agentTask?.summary.taskId === taskId
        ? { ...block, agentTask: update(block.agentTask) }
        : block),
    };
  }
  state.transcript = state.transcript.map((item) => item.agentTask?.summary.taskId === taskId
    ? { ...item, agentTask: update(item.agentTask) }
    : item);
}

export function moveSelection(selected: number, delta: number, count: number): number {
  if (count === 0 || delta === 0) return selected;
  return (selected + delta + count) % count;
}

export function reduceUiEvent(state: UiState, event: UiEvent): void {
  switch (event.type) {
    case "agent_task_created": {
      if (!state.liveTurn) return;
      const closed = endStreaming(state.liveTurn);
      state.liveTurn = {
        ...closed,
        blocks: [...closed.blocks, {
          id: `agent-task:${event.summary.taskId}`,
          kind: "agent_task",
          content: "",
          agentTask: { summary: event.summary, trace: [] },
        }],
      };
      return;
    }
    case "agent_task_updated": {
      updateTaskCard(state, event.summary.taskId, (card) => ({ ...card, summary: event.summary }));
      const running = state.liveTurn?.blocks.filter((block) =>
        block.agentTask && (block.agentTask.summary.status === "preparing" || block.agentTask.summary.status === "running")
      ).length ?? 0;
      if (running > 0 && (state.activity === "wait_tasks" || state.activity?.startsWith("workers "))) {
        state.activity = `workers ${running} running`;
      }
      return;
    }
    case "agent_task_trace": {
      updateTaskCard(state, event.taskId, (card) => {
        const child = event.event;
        if (child.type === "assistant_started") {
          const last = card.trace.at(-1);
          return last?.streaming
            ? { ...card, trace: [...card.trace.slice(0, -1), { ...last, streaming: false, finishedAt: Date.now() }] }
            : card;
        }
        if (child.type === "assistant_text_delta") return taskTraceText(card, "assistant", child.delta);
        if (child.type === "assistant_thinking_delta") return taskTraceText(card, "thinking", child.delta);
        if (child.type === "tool_started") {
          return {
            ...card,
            trace: [...card.trace, {
              id: `tool:${child.id}`,
              kind: "tool",
              content: "",
              tool: { id: child.id, name: child.name, args: child.args, status: "running", startedAt: Date.now() },
            }],
          };
        }
        return {
          ...card,
          trace: card.trace.map((block) => block.tool?.id === child.id
            ? { ...block, tool: { ...block.tool, status: child.isError ? "failed" : "completed", result: child.result, finishedAt: Date.now() } }
            : block),
        };
      });
      return;
    }
    case "command_started":
      state.busy = true;
      state.activity = `running /${event.name}`;
      state.notice = undefined;
      return;
    case "command_finished":
      state.busy = false;
      state.activity = undefined;
      return;
    case "session_changed":
      state.sessionId = event.sessionId;
      state.liveTipTurnId = event.liveTipTurnId;
      return;
    case "turn_preparing":
      state.busy = true;
      state.activity = "preparing";
      state.notice = undefined;
      state.liveTurn = {
        id: `pending:${Date.now()}`,
        input: event.input,
        sessionId: event.sessionId,
        blocks: [],
        startedAt: Date.now(),
      };
      return;
    case "turn_started":
      state.busy = true;
      state.activity ??= "thinking";
      state.notice = undefined;
      const existing = state.liveTurn;
      state.liveTurn = {
        id: event.turnId,
        input: event.input,
        sessionId: event.sessionId,
        blocks: existing?.input === event.input && existing.sessionId === event.sessionId ? existing.blocks : [],
        startedAt: existing?.startedAt ?? Date.now(),
      };
      return;
    case "assistant_started":
      if (state.liveTurn) state.liveTurn = endStreaming(state.liveTurn);
      state.activity = `thinking · step ${event.step}`;
      return;
    case "assistant_thinking_delta":
      if (state.liveTurn) state.liveTurn = appendLiveText(state.liveTurn, "thinking", event.delta);
      state.activity = `thinking · step ${event.step}`;
      return;
    case "assistant_text_delta":
      if (state.liveTurn) state.liveTurn = appendLiveText(state.liveTurn, "assistant", event.delta);
      state.activity = `responding · step ${event.step}`;
      return;
    case "model_retry_scheduled":
      state.activity = `retrying model · attempt ${event.attempt}/${event.maxAttempts} in ${(event.delayMs / 1000).toFixed(1)}s`;
      return;
    case "model_retry_started":
      state.activity = `retrying model · attempt ${event.attempt}/${event.maxAttempts}`;
      return;
    case "context_updated":
      return;
    case "tool_started": {
      if (AGENT_TASK_TOOL_NAMES.has(event.name)) {
        if (event.name === "wait_tasks") {
          const running = state.liveTurn?.blocks.filter((block) =>
            block.agentTask && (block.agentTask.summary.status === "preparing" || block.agentTask.summary.status === "running")
          ).length ?? 0;
          state.activity = running > 0 ? `workers ${running} running` : "waiting for workers";
        } else state.activity = event.name;
        return;
      }
      if (!state.liveTurn) return;
      const phase = event.phase ?? "running";
      const existing = state.liveTurn.blocks.findIndex((block) => block.tool?.id === event.id);
      if (existing >= 0) {
        const current = state.liveTurn.blocks[existing]!.tool!;
        if (current.status === "completed" || current.status === "failed") return;
        if (phase === "queued" && current.status === "running") return;
        state.liveTurn = {
          ...state.liveTurn,
          blocks: state.liveTurn.blocks.map((block, index) => index === existing
            ? { ...block, tool: { ...current, name: event.name, args: event.args, status: phase } }
            : block),
        };
      } else {
        const closed = endStreaming(state.liveTurn);
        state.liveTurn = {
          ...closed,
          blocks: [...closed.blocks, {
            id: `tool:${event.id}`,
            kind: "tool",
            content: "",
            tool: { id: event.id, name: event.name, args: event.args, status: phase, startedAt: Date.now() },
          }],
        };
      }
      state.activity = inFlightToolActivity(state.liveTurn);
      return;
    }
    case "tool_finished":
      if (state.liveTurn) {
        state.liveTurn = {
          ...state.liveTurn,
          blocks: state.liveTurn.blocks.map((block) => block.tool?.id === event.id
            ? { ...block, tool: { ...block.tool, status: event.isError ? "failed" : "completed", result: event.result, finishedAt: Date.now() } }
            : block),
        };
        state.activity = inFlightToolActivity(state.liveTurn);
      }
      return;
    case "compaction_started":
      if (state.liveTurn) state.liveTurn = endStreaming(state.liveTurn);
      state.activity = `compacting context · ${event.reason}`;
      return;
    case "compaction_finished": {
      state.activity = event.ok ? (event.entryId ? "context compacted" : "context unchanged") : "compaction failed";
      if (event.ok && event.entryId && state.liveTurn) {
        const closed = endStreaming(state.liveTurn);
        state.liveTurn = {
          ...closed,
          blocks: [
            ...closed.blocks,
            {
              id: `compaction:${event.entryId}`,
              kind: "compaction",
              content: `context compacted · ${event.reason}`,
            },
          ],
        };
      }
      return;
    }
    case "turn_finished":
      if (event.error) state.notice = { level: "error", text: event.error };
      return;
  }
}
