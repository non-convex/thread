import { AGENT_TASK_TOOL_NAMES } from "../core/agent-task/model.js";
import type { UiEvent } from "./events.js";
import type { AgentTaskCard, LiveTurn, UiState } from "./state.js";

function compactionDetail(event: {
  summarizedSteps?: number;
  retainedSteps?: number;
  tokensSaved?: number;
}): string | undefined {
  const parts: string[] = [];
  if (event.summarizedSteps !== undefined) parts.push(`${event.summarizedSteps} step(s) summarized`);
  if (event.retainedSteps !== undefined) parts.push(`${event.retainedSteps} retained`);
  if (event.tokensSaved !== undefined) parts.push(`~${event.tokensSaved} tokens freed`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
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
        block.agentTask && block.agentTask.summary.status === "running"
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
          const phase = child.phase ?? "running";
          const existing = card.trace.findIndex((block) => block.tool?.id === child.id);
          if (existing >= 0) {
            const current = card.trace[existing]!.tool!;
            if (current.status === "completed" || current.status === "failed" ||
                (phase === "queued" && current.status === "running")) return card;
            return {
              ...card,
              trace: card.trace.map((block, index) => index === existing
                ? { ...block, tool: { ...current, name: child.name, args: child.args, status: phase } }
                : block),
            };
          }
          return {
            ...card,
            trace: [...card.trace, {
              id: `tool:${child.id}`,
              kind: "tool",
              content: "",
              tool: { id: child.id, name: child.name, args: child.args, status: phase, startedAt: Date.now() },
            }],
          };
        }
        return {
          ...card,
          trace: card.trace.map((block) => block.tool?.id === child.id
            ? {
                ...block,
                content: child.content ?? block.content,
                tool: {
                  ...block.tool,
                  status: child.isError ? "failed" : "completed",
                  ...(child.error !== undefined ? { error: child.error } : {}),
                  finishedAt: Date.now(),
                },
              }
            : block),
        };
      });
      return;
    }
    case "command_started":
      state.busy = true;
      state.activity = `running /${event.name}`;
      state.notice = undefined;
      state.turnStartedAt = undefined;
      state.turnFinishedAt = undefined;
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
      state.turnStartedAt = Date.now();
      state.turnFinishedAt = undefined;
      state.liveTurn = {
        id: `pending:${Date.now()}`,
        input: event.input,
        sessionId: event.sessionId,
        blocks: [],
        startedAt: state.turnStartedAt,
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
            block.agentTask && block.agentTask.summary.status === "running"
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
            ? {
                ...block,
                content: event.content ?? block.content,
                tool: {
                  ...block.tool,
                  status: event.isError ? "failed" : "completed",
                  ...(event.error !== undefined ? { error: event.error } : {}),
                  finishedAt: Date.now(),
                },
              }
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
        const detail = compactionDetail(event);
        state.liveTurn = {
          ...closed,
          blocks: [
            ...closed.blocks,
            {
              id: `compaction:${event.entryId}`,
              kind: "compaction",
              content: `context compacted · ${event.reason}`,
              ...(detail ? { detail } : {}),
            },
          ],
        };
      }
      return;
    }
    case "turn_finished":
      if (state.liveTurn) state.liveTurn = endStreaming(state.liveTurn);
      if (state.turnStartedAt !== undefined && state.turnFinishedAt === undefined) {
        state.turnFinishedAt = Date.now();
      }
      if (event.outcome === "interrupted") state.notice = { level: "info", text: "Interrupted" };
      else if (event.error) state.notice = { level: "error", text: event.error };
      return;
  }
}
