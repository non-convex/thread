import type { PromptOptions } from "../core/runtime/options.js";
import type { TurnResult } from "../core/agent/runner.js";
import type { CommandResult } from "./commands/types.js";
import type { CommandEventSink } from "./events.js";
import { parseCommandLine } from "./commands/parser.js";

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

/** Only known read-only subcommands and next-turn preferences bypass turn admission. */
function isControlCommand(command: string | undefined, rest: string): boolean {
  if (command === "new" || command === "session" || command === "schedule" || command === "model") return true;
  if (["clear", "mcp", "skill", "rewind"].includes(command ?? "")) return !rest;
  if (command !== "agent" && command !== "thread") return false;
  let args: string[];
  try { args = parseCommandLine(rest); } catch { return false; }
  if (!args.length) return true;
  if (command === "thread") return ["status", "history", "sessions", "open"].includes(args[0]!)
    || (args[0] === "search" && args.length === 1);
  const [agent, action, ...selection] = args;
  if (agent === "main") return true;
  if (agent !== "worker" && agent !== "dreamer") return false;
  return !action || (action === "model" && (!selection.length
    || (selection.length === 1 && selection[0] === "all")
    || (selection[0] === "list" && selection.length <= 2)));
}

/** Parse once without a handler; paths such as /tmp/file remain ordinary input. */
export function parseInput(input: string): RoutedInput {
  const trimmed = input.trim();
  const command = slashCommandName(trimmed);
  const goal = command === "goal" ? parseGoalInput(input) : undefined;
  if (goal) Object.freeze(goal);
  const rest = command ? trimmed.slice(command.length + 1).trim() : "";
  const category: RoutedInput["category"] = isControlCommand(command, rest) || (goal && (goal.type === "status" || goal.type === "pause" || goal.type === "clear"))
    ? "control" : "work";
  return Object.freeze({ input, command, rest, goal, category });
}
