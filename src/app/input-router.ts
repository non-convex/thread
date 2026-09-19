import type { ImageContent } from "@earendil-works/pi-ai";
import type { TurnResult } from "../core/agent/runner.js";
import { parseCommandLine } from "./commands/parser.js";
import { clearDisplayResult, type CommandResult } from "./commands/types.js";
import type { UiEventSink } from "../ui/events.js";

export interface InputOptions {
  signal: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onUiEvent?: UiEventSink;
  images?: readonly ImageContent[];
}

export type InputResult =
  | { kind: "command"; result: CommandResult }
  | { kind: "turn"; result: TurnResult };

export interface InputRouteHandlers {
  newSession(options: InputOptions): Promise<InputResult>;
  agent(args: string[], options: InputOptions): Promise<InputResult>;
  model(args: string[], options: InputOptions): Promise<InputResult>;
  skill(name: string | undefined, extra: string | undefined, options: InputOptions): Promise<InputResult>;
  compact(options: InputOptions): Promise<InputResult>;
  session(args: string[], options: InputOptions): Promise<InputResult>;
  rewind(args: string[], options: InputOptions): Promise<InputResult>;
  thread(input: string, options: InputOptions): Promise<InputResult>;
  turn(input: string, options: InputOptions): Promise<InputResult>;
}

function slashCommandName(trimmed: string): string | undefined {
  if (!trimmed.startsWith("/")) return undefined;
  const name = trimmed.slice(1).split(/\s/, 1)[0] ?? "";
  if (!name || name.includes("/")) return undefined;
  return name;
}

/** Mirrors the router boundary so the TUI can keep attachments across commands. */
export function isSlashCommandInput(input: string): boolean {
  return slashCommandName(input.trim()) !== undefined;
}

/** Parses each slash command once; paths such as /tmp/file remain ordinary input. */
export class InputRouter {
  constructor(private readonly handlers: InputRouteHandlers) {}

  route(input: string, options: InputOptions): Promise<InputResult> {
    const trimmed = input.trim();
    const command = slashCommandName(trimmed);
    if (!command || command === "exit") return this.handlers.turn(input, options);
    const rest = trimmed.slice(command.length + 1).trim();
    switch (command) {
      case "new":
      case "compact":
      case "clear":
        if (rest) throw new Error(`Usage: /${command}`);
        if (command === "clear") return Promise.resolve({ kind: "command", result: clearDisplayResult() });
        return this.handlers[command === "new" ? "newSession" : "compact"](options);
      case "agent":
      case "model":
      case "session":
      case "rewind":
        return this.handlers[command](parseCommandLine(rest), options);
      case "skill": {
        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
        return this.handlers.skill(match?.[1], match?.[2]?.trim() || undefined, options);
      }
      case "thread":
        return this.handlers.thread(trimmed, options);
      default:
        throw new Error(`Unknown command: /${command}`);
    }
  }
}
