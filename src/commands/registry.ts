import type { CommandRegistry, CommandResult, ThreadCommandContext } from "./types.js";
import { parseCommandLine } from "./parser.js";

export const THREAD_COMMAND_PREFIX = "/thread";

export class ThreadCommandRouter {
  constructor(private readonly registry: CommandRegistry) {}

  async route(input: string, context: ThreadCommandContext): Promise<CommandResult | undefined> {
    const prefixLength = THREAD_COMMAND_PREFIX.length;
    if (!input.startsWith(THREAD_COMMAND_PREFIX) || (input.length > prefixLength && !/\s/.test(input[prefixLength]!))) {
      return undefined;
    }
    const args = parseCommandLine(input.slice(prefixLength).trim());
    if (args.length === 0) {
      return {
        content: this.registry.list().map((command) => `${THREAD_COMMAND_PREFIX} ${command.name} — ${command.description}`).join("\n"),
        presentation: "ephemeral",
        changedState: false,
      };
    }
    const name = args.shift()!;
    const command = this.registry.get(name);
    if (!command) throw new Error(`Unknown ${THREAD_COMMAND_PREFIX} command: ${name}`);
    return command.execute(args, context);
  }
}
