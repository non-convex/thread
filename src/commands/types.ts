import type { ModelDescriptor } from "../agent/model-client.js";
import type { CapsuleService } from "../revisions/capsule-service.js";
import type { DiffService } from "../revisions/diff-service.js";
import type { MergeService } from "../revisions/merge-service.js";
import type { ThreadDiffResult } from "../revisions/diff-service.js";
import type { ContextMergeStrategy, MergePreview } from "../revisions/merge-service.js";
import type { VersionService } from "../revisions/version-service.js";

export interface HistoryViewItem {
  turnId: string;
  userEntryId: string;
  baseCheckpointId: string;
  label: string;
  outcome: "running" | "completed" | "aborted" | "failed";
  startedAt: number;
}

export type EphemeralView =
  | { type: "document"; title: string; content: string }
  | {
      type: "model_picker";
      models: ModelDescriptor[];
      currentProviderId: string | undefined;
      currentModelId: string | undefined;
      scope: "configured" | "all";
    }
  | { type: "thread_diff"; result: ThreadDiffResult }
  | { type: "thread_merge"; preview: MergePreview; selectedContext: ContextMergeStrategy }
  | { type: "history"; items: HistoryViewItem[] };

export interface CommandResult {
  content: string;
  presentation: "ephemeral" | "view" | "clear";
  view?: EphemeralView;
  changedState: boolean;
}

export interface ThreadCommandContext {
  rootPath: string;
  versions: VersionService;
  diff: DiffService;
  merge: MergeService;
  capsules: CapsuleService;
  signal: AbortSignal;
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
