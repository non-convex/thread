import type { AgentRuntime, TurnResult } from "../../agent/runtime.js";
import type { RunTurnOptions } from "../../agent/turn-runner.js";

export class RunTurn {
  constructor(private readonly runtime: AgentRuntime) {}

  execute(input: string, options: RunTurnOptions): Promise<TurnResult> {
    return this.runtime.run(input, options);
  }
}
