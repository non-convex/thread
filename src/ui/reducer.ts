import { stripVTControlCharacters } from "node:util";
import { AGENT_TASK_TOOL_NAMES } from "../core/agent-task/model.js";
import { dreamerStatusLines } from "../app/commands/agents.js";
import type { UiEvent } from "./events.js";
import type { AgentTaskCard, LiveTurn, UiState } from "./state.js";
import { endStreaming, streamBlocks } from "./transcript-stream.js";

function inFlightToolActivity(live: LiveTurn | undefined): string {
  const names = live?.blocks
    .filter((block) => block.tool?.status === "queued" || block.tool?.status === "running")
    .map((block) => block.tool!.name) ?? [];
  if (!names.length) return "thinking";
  if (names.length === 1) return names[0]!;
  const unique = [...new Set(names)];
  if (unique.length === 1) return `${unique[0]} ×${names.length}`;
  return unique.length <= 3 ? unique.join(" · ") : `${unique[0]} · ${unique[1]} +${unique.length - 2}`;
}

function updateTaskCard(state: UiState, taskId: string, update: (card: AgentTaskCard) => AgentTaskCard): void {
  const updateItem = <T extends UiState["transcript"][number]>(item: T): T => item.agentTask?.summary.taskId === taskId
    ? { ...item, agentTask: update(item.agentTask) } : item;
  if (state.liveTurn) state.liveTurn = { ...state.liveTurn, blocks: state.liveTurn.blocks.map(updateItem) };
  state.transcript = state.transcript.map(updateItem);
}

function runningWorkers(state: UiState): number {
  return state.liveTurn?.blocks.filter((block) => block.agentTask?.summary.status === "running").length ?? 0;
}

export function reduceUiEvent(state: UiState, event: UiEvent): void {
  switch (event.type) {
    case "dreamer_status":
      if (state.screen.type === "agent_settings" && state.screen.agentId === "dreamer") {
        state.screen.enabled = event.status.enabled;
        state.screen.details = [...(state.screen.details?.slice(0, 1) ?? []), ...dreamerStatusLines(event.status)];
      }
      return;
    case "agent_task_created":
      if (state.liveTurn) state.liveTurn = { ...state.liveTurn, blocks: [...endStreaming(state.liveTurn.blocks), {
        id: `agent-task:${event.summary.taskId}`, kind: "agent_task", content: "",
        agentTask: { summary: event.summary, trace: [] },
      }] };
      return;
    case "agent_task_updated": {
      updateTaskCard(state, event.summary.taskId, (card) => ({ ...card, summary: event.summary }));
      const running = runningWorkers(state);
      if (running && (state.activity === "wait_tasks" || state.activity?.startsWith("workers "))) {
        state.activity = `workers ${running} running`;
      }
      return;
    }
    case "agent_task_trace":
      updateTaskCard(state, event.taskId, (card) => ({ ...card, trace: streamBlocks(card.trace, event.event) }));
      return;
    case "command_started":
      Object.assign(state, { busy: true, activity: `running /${event.name}`, modelRetryError: undefined, notice: undefined,
        turnStartedAt: undefined, turnFinishedAt: undefined });
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
      state.modelRetryError = undefined;
      state.notice = undefined;
      state.turnStartedAt = Date.now();
      state.turnFinishedAt = undefined;
      state.liveTurn = { id: `pending:${Date.now()}`, input: event.input, sessionId: event.sessionId,
        blocks: [], startedAt: state.turnStartedAt };
      return;
    case "turn_started": {
      state.busy = true;
      state.activity ??= "thinking";
      state.modelRetryError = undefined;
      state.notice = undefined;
      const previous = state.liveTurn;
      state.liveTurn = { id: event.turnId, input: event.input, sessionId: event.sessionId,
        blocks: previous?.input === event.input && previous.sessionId === event.sessionId ? previous.blocks : [],
        startedAt: previous?.startedAt ?? Date.now() };
      return;
    }
    case "model_retry_scheduled":
      state.modelRetryError = stripVTControlCharacters(event.errorMessage).replace(/\s+/g, " ").trim().slice(0, 240) || "Unknown error";
      state.activity = `retrying model · attempt ${event.attempt}/${event.maxAttempts} in ${(event.delayMs / 1000).toFixed(1)}s · ${state.modelRetryError}`;
      return;
    case "model_retry_started":
      state.activity = `retrying model · attempt ${event.attempt}/${event.maxAttempts}${state.modelRetryError ? ` · ${state.modelRetryError}` : ""}`;
      return;
    case "assistant_tool_call_progress":
      state.modelRetryError = undefined;
      state.activity = `generating ${event.name} · ${(event.argumentBytes / 1024).toFixed(1)} KiB · step ${event.step}`;
      return;
    case "tool_started":
      if (AGENT_TASK_TOOL_NAMES.has(event.name)) {
        const running = runningWorkers(state);
        state.activity = event.name === "wait_tasks"
          ? running ? `workers ${running} running` : "waiting for workers" : event.name;
        return;
      }
      if (!state.liveTurn) return;
      break;
    case "compaction_finished": {
      state.activity = event.ok ? (event.entryId ? "context compacted" : "context unchanged") : "compaction failed";
      if (event.ok && event.entryId && state.liveTurn) {
        const detail = [
          event.summarizedSteps !== undefined ? `${event.summarizedSteps} step(s) summarized` : "",
          event.retainedSteps !== undefined ? `${event.retainedSteps} retained` : "",
          event.tokensSaved !== undefined ? `~${event.tokensSaved} tokens freed` : "",
        ].filter(Boolean).join(" · ");
        state.liveTurn = { ...state.liveTurn, blocks: [...endStreaming(state.liveTurn.blocks), {
          id: `compaction:${event.entryId}`, kind: "compaction", content: `context compacted · ${event.reason}`,
          ...(detail ? { detail } : {}),
        }] };
      }
      return;
    }
  }
  if (state.liveTurn) state.liveTurn = { ...state.liveTurn, blocks: streamBlocks(state.liveTurn.blocks, event) };
  switch (event.type) {
    case "assistant_started":
      state.modelRetryError = undefined;
      state.activity = `waiting for model · step ${event.step}`;
      break;
    case "assistant_thinking_delta":
      state.modelRetryError = undefined;
      state.activity = `thinking · step ${event.step}`;
      break;
    case "assistant_text_delta":
      state.modelRetryError = undefined;
      state.activity = `responding · step ${event.step}`;
      break;
    case "tool_started":
    case "tool_finished":
      if (state.liveTurn) state.activity = inFlightToolActivity(state.liveTurn);
      break;
    case "compaction_started": state.activity = `compacting context · ${event.reason}`; break;
    case "turn_finished":
      state.modelRetryError = undefined;
      if (state.turnStartedAt !== undefined) state.turnFinishedAt ??= Date.now();
      if (event.outcome === "interrupted") state.notice = { level: "info", text: "Interrupted" };
      else if (event.error) state.notice = { level: "error", text: event.error };
  }
}
