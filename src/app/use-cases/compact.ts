import type { AgentRuntime } from "../../agent/runtime.js";
import type { RunTurnOptions } from "../../agent/turn-runner.js";
import type { CompactionResult } from "../../context/compaction/index.js";

export class Compact {
  constructor(private readonly runtime: AgentRuntime) {}

  execute(options: RunTurnOptions): Promise<CompactionResult> {
    return this.runtime.compactCurrent(options);
  }
}
