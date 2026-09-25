import type { ModelDescriptor } from "../core/agent/model-catalog.js";
import type { EphemeralView } from "../app/commands/types.js";
import type { AskRequest } from "../core/runtime/interaction.js";
import type { AgentTaskSummary } from "../core/agent-task/model.js";
import type { ToolOutcome } from "../core/tools/types.js";

export interface TranscriptItem {
  id: string;
  kind: "user" | "assistant" | "thinking" | "tool" | "compaction" | "agent_task" | "interrupted";
  content: string;
  /** Complete final response, attached only to its last text block after tool calls are known. */
  replyCopyContent?: string;
  tool?: TranscriptTool;
  streaming?: boolean;
  startedAt?: number;
  finishedAt?: number;
  agentTask?: AgentTaskCard;
  /** Full compaction summary; the collapsed row stays in `content`. */
  detail?: string;
}

export interface AgentTaskCard {
  summary: AgentTaskSummary;
  /** Initial task input actually sent to the worker; absent before it starts. */
  prompt?: string;
  trace: LiveBlock[];
}

export interface TranscriptTool {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "queued" | "running" | ToolOutcome;
  details?: unknown;
  durationMs?: number;
}

export type LiveBlock = TranscriptItem & {
  kind: "thinking" | "assistant" | "tool" | "compaction" | "agent_task";
};

export interface LiveTurn {
  id: string;
  input: string;
  sessionId: string;
  blocks: LiveBlock[];
  startedAt: number;
}

type View<K extends EphemeralView["type"]> = Extract<EphemeralView, { type: K }>;
interface SelectionState {
  selected: number;
  busy: boolean;
  error: string | undefined;
}
export type ModelPickerScreen = View<"model_picker"> & SelectionState & { filter: string };
export type AgentSettingsScreen = View<"agent_settings"> & SelectionState;
export type CommandPickerScreen = View<"command_picker"> & SelectionState;
export type AgentPickerScreen = View<"agent_picker"> & SelectionState;
export type RewindScreen = View<"rewind"> & SelectionState & { confirm: boolean };

export interface AskScreen {
  type: "ask";
  request: AskRequest;
  questionIndex: number;
  chosen: number[][];
  answers: string[][];
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
  return "busy" in screen;
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
  modelRetryError: string | undefined;
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
    modelRetryError: undefined,
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

/** Use live blocks during execution and the same turn's saved blocks after handoff. */
export function currentTurnItems(
  state: Pick<UiState, "sessionId" | "liveTurn" | "liveTipTurnId" | "transcript">,
): readonly TranscriptItem[] {
  if (state.liveTurn) return state.liveTurn.sessionId === state.sessionId ? state.liveTurn.blocks : [];
  if (!state.liveTipTurnId) return [];
  const start = state.transcript.findLastIndex((item) => item.kind === "user" && item.id === `${state.liveTipTurnId}:user`);
  if (start < 0) return [];
  const end = state.transcript.findIndex((item, index) => index > start && item.kind === "user");
  return state.transcript.slice(start + 1, end < 0 ? undefined : end);
}

/** Per-call additions/deletions for the active turn, or the selected session's live tip. */
export function turnChangeCounts(
  state: Pick<UiState, "sessionId" | "liveTurn" | "liveTipTurnId" | "transcript">,
): { additions: number; deletions: number } {
  const totals = { additions: 0, deletions: 0 };
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const collect = (items: readonly TranscriptItem[]): void => {
    for (const item of items) {
      if (item.kind === "user") break;
      if (item.agentTask) collect(item.agentTask.trace);
      const tool = item.tool;
      if (!tool || tool.status !== "completed" || (tool.name !== "edit" && tool.name !== "write")) continue;
      if (!tool.details || typeof tool.details !== "object") continue;
      const details = tool.details as { additions?: unknown; deletions?: unknown };
      totals.additions += count(details.additions);
      totals.deletions += count(details.deletions);
    }
  };
  collect(currentTurnItems(state));
  return totals;
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
  const selection: SelectionState = { selected: 0, busy: false, error: undefined };
  switch (view.type) {
    case "composer": return; // Consumed by the controller, not a screen.
    case "document": state.screen = { ...view }; return;
    case "model_picker": {
      const filter = view.filter ?? "";
      const current = filteredModels({ models: view.models, filter }).findIndex((model) =>
        model.providerId === view.currentProviderId && model.modelId === view.currentModelId
      );
      state.screen = { ...view, ...selection, filter, selected: Math.max(0, current) };
      return;
    }
    case "command_picker":
      selection.selected = Math.max(0, view.items.findIndex((item) => item.current));
      break;
    case "agent_settings": selection.selected = Number(view.enabled); break;
    case "rewind": state.screen = { ...view, ...selection, confirm: false }; return;
  }
  state.screen = { ...view, ...selection };
}

export function moveSelection(selected: number, delta: number, count: number): number {
  if (count === 0 || delta === 0) return selected;
  return (selected + delta + count) % count;
}
