import type { TurnResult } from "../agent/runtime.js";
import { parseCommandLine } from "../commands/parser.js";
import { THREAD_COMMAND_PREFIX } from "../commands/registry.js";
import { clearDisplayResult, type CommandResult } from "../commands/types.js";
import type { UiEventSink } from "../ui/events.js";

export interface InputOptions {
  signal: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onUiEvent?: UiEventSink;
}

export type InputResult =
  | { kind: "command"; result: CommandResult }
  | { kind: "turn"; result: TurnResult };

export interface InputRouteHandlers {
  newSession(options: InputOptions): Promise<InputResult>;
  agent(args: string[], options: InputOptions): Promise<InputResult>;
  model(args: string[], options: InputOptions): Promise<InputResult>;
  subagent(args: string[], options: InputOptions): Promise<InputResult>;
  skill(name: string | undefined, extra: string | undefined, options: InputOptions): Promise<InputResult>;
  compact(options: InputOptions): Promise<InputResult>;
  session(args: string[], options: InputOptions): Promise<InputResult>;
  rewind(args: string[], options: InputOptions): Promise<InputResult>;
  thread(input: string, options: InputOptions): Promise<InputResult>;
  turn(input: string, options: InputOptions): Promise<InputResult>;
}

/** Parses user input and routes it without owning application or model state. */
export class InputRouter {
  constructor(private readonly handlers: InputRouteHandlers) {}

  route(input: string, options: InputOptions): Promise<InputResult> {
    const trimmed = input.trim();
    if (trimmed === "/new") return this.handlers.newSession(options);
    if (trimmed.startsWith("/new ")) throw new Error("Usage: /new");
    if (trimmed === "/clear") return Promise.resolve({ kind: "command", result: clearDisplayResult() });
    if (trimmed === "/agent" || trimmed.startsWith("/agent ")) {
      return this.handlers.agent(parseCommandLine(trimmed.slice(6).trim()), options);
    }
    if (trimmed === "/model" || trimmed.startsWith("/model ")) {
      return this.handlers.model(parseCommandLine(trimmed.slice(6).trim()), options);
    }
    if (trimmed === "/subagent" || trimmed.startsWith("/subagent ")) {
      return this.handlers.subagent(parseCommandLine(trimmed.slice(9).trim()), options);
    }
    if (trimmed === "/skill" || trimmed.startsWith("/skill ")) {
      const rest = trimmed.slice(6).trim();
      const separator = rest.search(/\s/);
      const name = !rest ? undefined : separator < 0 ? rest : rest.slice(0, separator);
      const extra = !rest || separator < 0 ? undefined : rest.slice(separator + 1).trim() || undefined;
      return this.handlers.skill(name, extra, options);
    }
    if (trimmed === "/compact") return this.handlers.compact(options);
    if (trimmed.startsWith("/compact ")) throw new Error("Usage: /compact");
    if (trimmed === "/session" || trimmed.startsWith("/session ")) {
      return this.handlers.session(parseCommandLine(trimmed.slice(8).trim()), options);
    }
    if (trimmed === "/rewind" || trimmed.startsWith("/rewind ")) {
      return this.handlers.rewind(parseCommandLine(trimmed.slice(7).trim()), options);
    }
    if (trimmed === THREAD_COMMAND_PREFIX || trimmed.startsWith(`${THREAD_COMMAND_PREFIX} `)) {
      return this.handlers.thread(trimmed, options);
    }
    return this.handlers.turn(input, options);
  }
}
