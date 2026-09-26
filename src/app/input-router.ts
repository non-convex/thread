import type { PromptOptions } from "../core/runtime/options.js";
import type { TurnResult } from "../core/agent/runner.js";
import { parseCommandLine } from "./commands/parser.js";
import { clearDisplayResult, type CommandResult } from "./commands/types.js";
import type { CommandEventSink } from "./events.js";

export interface InputOptions extends PromptOptions {
  signal: AbortSignal;
  onCommandEvent?: CommandEventSink;
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
  goal(action: GoalInputAction, options: InputOptions): Promise<InputResult>;
  turn(input: string, options: InputOptions): Promise<InputResult>;
}

export type GoalInputAction = { readonly type: "status" | "pause" | "resume" | "clear" } | { readonly type: "run"; readonly objective: string };

/** Keep the objective verbatim (including quotes and trailing whitespace). */
function parseGoalInput(input: string): GoalInputAction | undefined {
  const start = input.trimStart();
  if (!/^\/goal(?:\s|$)/.test(start)) return undefined;
  const rest = start.slice(5).replace(/^\s/, "");
  const command = rest.trim();
  if (!command || command === "status") return { type: "status" };
  if (command === "pause" || command === "resume" || command === "clear") return { type: command };
  return { type: "run", objective: rest };
}

export interface RoutedInput {
  readonly input: string;
  readonly command: string | undefined;
  readonly rest: string;
  readonly goal: GoalInputAction | undefined;
  readonly category: "work" | "control";
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

/** Parse once without a handler; paths such as /tmp/file remain ordinary input. */
export function parseInput(input: string): RoutedInput {
  const trimmed = input.trim();
  const command = slashCommandName(trimmed);
  const goal = command === "goal" ? parseGoalInput(input) : undefined;
  if (goal) Object.freeze(goal);
  const category: RoutedInput["category"] = goal && (goal.type === "status" || goal.type === "pause" || goal.type === "clear")
    ? "control" : "work";
  return Object.freeze({ input, command, rest: command ? trimmed.slice(command.length + 1).trim() : "", goal, category });
}

export class InputRouter {
  constructor(private readonly handlers: InputRouteHandlers) {}

  route(route: RoutedInput, options: InputOptions): Promise<InputResult> {
    const { input, command, rest, goal } = route;
    if (!command || command === "exit") return this.handlers.turn(input, options);
    switch (command) {
      case "goal": return this.handlers.goal(goal!, options);
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
        return this.handlers.thread(input.trim(), options);
      default:
        throw new Error(`Unknown command: /${command}`);
    }
  }
}
