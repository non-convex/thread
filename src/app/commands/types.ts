import type { ModelDescriptor } from "../../core/agent/model-client.js";
import type { ThreadRuntime } from "../../core/runtime/thread-runtime.js";

export interface HistoryViewItem {
  turnId: string;
  userEntryId: string;
  label: string;
  outcome: "running" | "completed" | "interrupted" | "failed";
  startedAt: number;
  status: "current-path" | "current-session-off-path" | "other-session";
}

export interface AgentPickerItem {
  id: string;
  label: string;
  enabled: boolean;
  detail: string;
}

export interface CommandPickerItem {
  label: string;
  description: string;
  command: string;
  /** False fills the composer so the user can supply arguments before running. */
  submit: boolean;
  current?: boolean;
}

export type EphemeralView =
  | { type: "document"; title: string; content: string }
  | { type: "command_picker"; title: string; items: CommandPickerItem[]; emptyText?: string }
  | { type: "composer"; text: string; hint: string }
  | {
      type: "model_picker";
      agentId: string;
      models: ModelDescriptor[];
      currentProviderId: string | undefined;
      currentModelId: string | undefined;
      scope: "configured" | "all";
      filter?: string;
    }
  | { type: "agent_settings"; agentId: string; label: string; enabled: boolean }
  | { type: "agent_picker"; agents: AgentPickerItem[] }
  | { type: "rewind"; items: HistoryViewItem[] };

export interface CommandResult {
  content: string;
  presentation: "ephemeral" | "view" | "clear";
  view?: EphemeralView;
  changedState: boolean;
}

export interface ThreadCommandContext {
  rootPath: string;
  runtime: Pick<ThreadRuntime, "readHistory" | "readSession" | "listSessions" | "rewindCandidates" | "recallEnabled" | "searchHistory">;
  selectedSessionId: string;
  skillDiagnostics?: readonly import("../../core/skills/loader.js").SkillDiagnostic[];
  skills?: readonly import("../../core/skills/loader.js").Skill[];
  signal: AbortSignal;
  /** CLI adapter operation for changing the selected session. */
  openSession: (id: string) => Promise<import("../../core/session-tree/model.js").ProjectSession>;
}

export interface ThreadCommand {
  name: string;
  description: string;
  execute(args: string[], context: ThreadCommandContext): Promise<CommandResult>;
}

export class CommandRegistry {
  private readonly commands = new Map<string, ThreadCommand>();

  register(command: ThreadCommand): () => void {
    if (this.commands.has(command.name)) throw new Error(`Command already registered: ${command.name}`);
    this.commands.set(command.name, command);
    return () => this.commands.delete(command.name);
  }

  get(name: string): ThreadCommand | undefined {
    return this.commands.get(name);
  }

  list(): ThreadCommand[] {
    return [...this.commands.values()].sort((left, right) => left.name.localeCompare(right.name));
  }
}

export function ephemeral(content: string, changedState = false): CommandResult {
  return { content, presentation: "ephemeral", changedState };
}

export function viewResult(content: string, view: EphemeralView, changedState = false): CommandResult {
  return { content, presentation: "view", view, changedState };
}

export function clearDisplayResult(): CommandResult {
  return { content: "Display cleared", presentation: "clear", changedState: false };
}
