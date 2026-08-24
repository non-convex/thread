import type { ModelDescriptor } from "../agent/model-client.js";
import type { EphemeralView, HistoryViewItem } from "../commands/types.js";
import type { ThreadDiffResult } from "../revisions/diff-service.js";
import type { ContextMergeStrategy, MergePreview } from "../revisions/merge-service.js";
import type { ToolResult } from "../tools/types.js";
import type { UiEvent } from "./events.js";

export interface TranscriptItem {
  id: string;
  kind: "user" | "assistant" | "thinking" | "tool" | "compaction" | "context_merge";
  content: string;
  label?: string;
  isError?: boolean;
}

export interface LiveTool {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  result?: ToolResult;
}

export interface LiveBlock {
  id: string;
  kind: "thinking" | "assistant" | "tool";
  content: string;
  streaming?: boolean;
  tool?: LiveTool;
}

export interface LiveTurn {
  id: string;
  input: string;
  branch: string;
  blocks: LiveBlock[];
  startedAt: number;
}

export interface ModelPickerScreen {
  type: "model_picker";
  models: ModelDescriptor[];
  currentProviderId: string | undefined;
  currentModelId: string | undefined;
  scope: "configured" | "all";
  selected: number;
  busy: boolean;
  error: string | undefined;
}

export type UiScreen =
  | { type: "session" }
  | { type: "document"; title: string; content: string }
  | ModelPickerScreen
  | { type: "diff"; result: ThreadDiffResult; tab: "summary" | "context" | "workspace" }
  | {
      type: "merge";
      preview: MergePreview;
      selected: ContextMergeStrategy;
      note: string | undefined;
      confirm: boolean;
      busy: boolean;
      error: string | undefined;
    }
  | {
      type: "history";
      items: HistoryViewItem[];
      selected: number;
      confirm: boolean;
      busy: boolean;
      error: string | undefined;
    };

export interface UiState {
  screen: UiScreen;
  transcript: TranscriptItem[];
  liveTurn: LiveTurn | undefined;
  busy: boolean;
  activity: string | undefined;
  notice: { level: "info" | "success" | "error"; text: string } | undefined;
  branch: string;
  checkpointId: string;
}

export function createUiState(branch: string, checkpointId: string, transcript: TranscriptItem[]): UiState {
  return {
    screen: { type: "session" },
    transcript,
    liveTurn: undefined,
    busy: false,
    activity: undefined,
    notice: undefined,
    branch,
    checkpointId,
  };
}

export function openEphemeralView(state: UiState, view: EphemeralView): void {
  if (view.type === "document") state.screen = { type: "document", title: view.title, content: view.content };
  if (view.type === "model_picker") {
    const current = view.models.findIndex(
      (model) => model.providerId === view.currentProviderId && model.modelId === view.currentModelId,
    );
    state.screen = {
      type: "model_picker",
      models: view.models,
      currentProviderId: view.currentProviderId,
      currentModelId: view.currentModelId,
      scope: view.scope,
      selected: current >= 0 ? current : 0,
      busy: false,
      error: undefined,
    };
  }
  if (view.type === "thread_diff") state.screen = { type: "diff", result: view.result, tab: "summary" };
  if (view.type === "thread_merge") {
    state.screen = {
      type: "merge",
      preview: view.preview,
      selected: view.selectedContext,
      note: undefined,
      confirm: false,
      busy: false,
      error: undefined,
    };
  }
  if (view.type === "history") {
    state.screen = {
      type: "history",
      items: view.items,
      selected: 0,
      confirm: false,
      busy: false,
      error: undefined,
    };
  }
}

function endStreaming(live: LiveTurn): LiveTurn {
  const last = live.blocks.at(-1);
  if (!last?.streaming) return live;
  return {
    ...live,
    blocks: [...live.blocks.slice(0, -1), { ...last, streaming: false }],
  };
}

function appendLiveText(live: LiveTurn, kind: "thinking" | "assistant", delta: string): LiveTurn {
  if (!delta) return live;
  const last = live.blocks.at(-1);
  if (last?.kind === kind && last.streaming) {
    return {
      ...live,
      blocks: [...live.blocks.slice(0, -1), { ...last, content: last.content + delta }],
    };
  }
  const closed = endStreaming(live);
  return {
    ...closed,
    blocks: [
      ...closed.blocks,
      {
        id: `${kind}:${closed.blocks.length + 1}`,
        kind,
        content: delta,
        streaming: true,
      },
    ],
  };
}

export function moveModelSelection(screen: ModelPickerScreen, delta: number): void {
  if (screen.models.length === 0 || delta === 0) return;
  screen.selected = (screen.selected + delta + screen.models.length) % screen.models.length;
  screen.error = undefined;
}

export function reduceUiEvent(state: UiState, event: UiEvent): void {
  switch (event.type) {
    case "command_started":
      state.busy = true;
      state.activity = ["clear", "compact", "model", "rewind"].includes(event.name)
        ? `running /${event.name}`
        : `running /thread ${event.name}`;
      state.notice = undefined;
      return;
    case "command_finished":
      state.busy = false;
      state.activity = undefined;
      return;
    case "head_changed":
      state.branch = event.branch;
      state.checkpointId = event.checkpointId;
      return;
    case "turn_started":
      state.busy = true;
      state.activity = "thinking";
      state.notice = undefined;
      state.liveTurn = {
        id: event.turnId,
        input: event.input,
        branch: event.branch,
        blocks: [],
        startedAt: Date.now(),
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
    case "tool_started": {
      if (!state.liveTurn) return;
      const closed = endStreaming(state.liveTurn);
      state.liveTurn = {
        ...closed,
        blocks: [
          ...closed.blocks,
          {
            id: `tool:${event.id}`,
            kind: "tool",
            content: "",
            tool: {
              id: event.id,
              name: event.name,
              args: event.args,
              status: "running",
            },
          },
        ],
      };
      state.activity = event.name;
      return;
    }
    case "tool_finished": {
      if (state.liveTurn) {
        state.liveTurn = {
          ...state.liveTurn,
          blocks: state.liveTurn.blocks.map((block) => {
            if (block.tool?.id !== event.id) return block;
            return {
              ...block,
              tool: {
                ...block.tool,
                status: event.isError ? "failed" : "completed",
                result: event.result,
              },
            };
          }),
        };
      }
      state.activity = event.isError ? `${event.name} failed` : event.name;
      return;
    }
    case "compaction_started":
      state.activity = `compacting context · ${event.reason}`;
      return;
    case "compaction_finished":
      state.activity = event.ok ? "context compacted" : "compaction failed";
      return;
    case "turn_finished":
      state.busy = false;
      state.activity = undefined;
      if (event.error) state.notice = { level: "error", text: event.error };
      return;
  }
}
