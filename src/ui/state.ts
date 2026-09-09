import type { ModelDescriptor } from "../core/agent/model-client.js";
import type { AgentPickerItem, CommandPickerItem, EphemeralView, HistoryViewItem } from "../app/commands/types.js";
import type { AskRequest } from "../core/runtime/interaction.js";
import type { AgentTaskSummary } from "../core/agent-task/model.js";

export interface TranscriptItem {
  id: string;
  kind: "user" | "assistant" | "thinking" | "tool" | "compaction" | "agent_task" | "interrupted";
  content: string;
  label?: string;
  isError?: boolean;
  name?: string;
  args?: string;
  elapsed?: string;
  agentTask?: AgentTaskCard;
  /** Full compaction summary; the collapsed row stays in `content`. */
  detail?: string;
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
  /** Truncated failure text. Successful results stay out of presentation state. */
  error?: string;
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
  detail?: string;
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
  agentId: string;
  models: ModelDescriptor[];
  currentProviderId: string | undefined;
  currentModelId: string | undefined;
  scope: "configured" | "all";
  filter: string;
  selected: number;
  busy: boolean;
  error: string | undefined;
}

export interface AgentSettingsScreen {
  type: "agent_settings";
  agentId: string;
  label: string;
  enabled: boolean;
  selected: number;
  busy: boolean;
  error: string | undefined;
}

export interface CommandPickerScreen {
  type: "command_picker";
  title: string;
  items: CommandPickerItem[];
  emptyText?: string;
  selected: number;
  busy: boolean;
  error: string | undefined;
}

export interface AgentPickerScreen {
  type: "agent_picker";
  agents: AgentPickerItem[];
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
  | AgentSettingsScreen
  | AgentPickerScreen
  | RewindScreen
  | CommandPickerScreen
  | AskScreen;

export type FloatingOverlayScreen = ModelPickerScreen | AgentSettingsScreen | AgentPickerScreen | RewindScreen | CommandPickerScreen;

export function isFloatingOverlay(screen: UiScreen): screen is FloatingOverlayScreen {
  return screen.type === "model_picker"
    || screen.type === "agent_settings"
    || screen.type === "agent_picker"
    || screen.type === "command_picker"
    || screen.type === "rewind";
}

export function filteredModels(screen: Pick<ModelPickerScreen, "models" | "filter">): ModelDescriptor[] {
  const query = screen.filter.trim().toLowerCase();
  if (!query) return screen.models;
  return screen.models.filter((model) => {
    const identifier = `${model.providerId}/${model.modelId}`.toLowerCase();
    // `/model list <provider>` starts with an exact provider prefix, not a suffix match.
    return query.endsWith("/")
      ? identifier.startsWith(query)
      : `${identifier} ${model.name.toLowerCase()}`.includes(query);
  });
}

export function overlaySelectionCount(screen: FloatingOverlayScreen): number {
  // The last model-picker row switches between configured and all models.
  if (screen.type === "model_picker") return filteredModels(screen).length + 1;
  if (screen.type === "agent_settings") return 3;
  if (screen.type === "agent_picker") return screen.agents.length;
  return screen.items.length;
}

export interface UiState {
  screen: UiScreen;
  /** One-shot request consumed by the terminal composer after a menu choice. */
  composerInput?: string;
  transcript: TranscriptItem[];
  liveTurn: LiveTurn | undefined;
  busy: boolean;
  activity: string | undefined;
  notice: { level: "info" | "success" | "error"; text: string } | undefined;
  sessionId: string;
  liveTipTurnId: string | null;
  turnStartedAt: number | undefined;
  turnFinishedAt: number | undefined;
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
    turnStartedAt: undefined,
    turnFinishedAt: undefined,
  };
}

export function formatDurationMs(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 60_000) return `${(clamped / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(clamped / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function turnElapsedMs(state: Pick<UiState, "turnStartedAt" | "turnFinishedAt">, now: number): number | undefined {
  if (state.turnStartedAt === undefined) return undefined;
  return Math.max(0, (state.turnFinishedAt ?? now) - state.turnStartedAt);
}

export function statusLineParts(
  state: Pick<UiState, "busy" | "activity" | "notice" | "turnStartedAt" | "turnFinishedAt">,
  now: number,
): { main: string; elapsed?: string } {
  const ms = turnElapsedMs(state, now);
  const elapsed = ms === undefined ? undefined : formatDurationMs(ms);
  if (state.busy) {
    return { main: state.activity ?? "working", ...(elapsed ? { elapsed } : {}) };
  }
  if (state.notice?.text) {
    return { main: state.notice.text, ...(elapsed ? { elapsed } : {}) };
  }
  return { main: elapsed ? `worked ${elapsed}` : "" };
}

export function openEphemeralView(state: UiState, view: EphemeralView): void {
  if (view.type === "document") state.screen = { type: "document", title: view.title, content: view.content };
  if (view.type === "command_picker") {
    const current = view.items.findIndex((item) => item.current);
    state.screen = { ...view, selected: current >= 0 ? current : 0, busy: false, error: undefined };
  }
  if (view.type === "model_picker") {
    const filter = view.filter ?? "";
    const current = filteredModels({ models: view.models, filter }).findIndex((model) =>
      model.providerId === view.currentProviderId && model.modelId === view.currentModelId
    );
    state.screen = {
      type: "model_picker",
      agentId: view.agentId,
      models: view.models,
      currentProviderId: view.currentProviderId,
      currentModelId: view.currentModelId,
      scope: view.scope,
      filter,
      selected: current >= 0 ? current : 0,
      busy: false,
      error: undefined,
    };
  }
  if (view.type === "agent_settings") {
    state.screen = {
      type: "agent_settings",
      agentId: view.agentId,
      label: view.label,
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
  if (view.type === "agent_picker") {
    state.screen = {
      type: "agent_picker",
      agents: view.agents,
      selected: 0,
      busy: false,
      error: undefined,
    };
  }
}

export function moveSelection(selected: number, delta: number, count: number): number {
  if (count === 0 || delta === 0) return selected;
  return (selected + delta + count) % count;
}
