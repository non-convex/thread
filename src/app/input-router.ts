import type { PromptOptions } from "../core/runtime/options.js";
import type { TurnResult } from "../core/agent/runner.js";
import type { CommandResult } from "./commands/types.js";
import type { CommandEventSink } from "./events.js";

export interface InputOptions extends PromptOptions {
  signal: AbortSignal;
  onCommandEvent?: CommandEventSink;
}

export type InputResult =
  | { kind: "command"; result: CommandResult }
  | { kind: "turn"; result: TurnResult };

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
  const rest = command ? trimmed.slice(command.length + 1).trim() : "";
  const navigation = command === "new" || command === "session" || (command === "thread" && /^(?:sessions|open)(?:\s|$)/.test(rest));
  const category: RoutedInput["category"] = navigation || command === "schedule" || (command === "mcp" && !rest) || (goal && (goal.type === "status" || goal.type === "pause" || goal.type === "clear"))
    ? "control" : "work";
  return Object.freeze({ input, command, rest, goal, category });
}
