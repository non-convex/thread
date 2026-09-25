import type { ExecutionEvent } from "../core/runtime/events.js";
import type { LiveBlock } from "./state.js";

export function endStreaming(blocks: LiveBlock[]): LiveBlock[] {
  const last = blocks.at(-1);
  return last?.streaming
    ? [...blocks.slice(0, -1), { ...last, streaming: false, finishedAt: Date.now() }]
    : blocks;
}

/** Main and worker streams use identical text and tool-call lifecycle rules. */
export function streamBlocks(blocks: LiveBlock[], event: ExecutionEvent): LiveBlock[] {
  switch (event.type) {
    case "agent_run_started": {
      if (!event.entryId || blocks.some((block) => block.id === event.entryId)) return blocks;
      return [...endStreaming(blocks), { id: event.entryId, kind: "user", content: event.input }];
    }
    case "assistant_started":
    case "compaction_started":
    case "agent_run_finished":
    case "turn_finished":
      return endStreaming(blocks);
    case "assistant_text_delta":
    case "assistant_thinking_delta": {
      if (!event.delta) return blocks;
      const kind = event.type === "assistant_text_delta" ? "assistant" : "thinking";
      const last = blocks.at(-1);
      if (last?.kind === kind && last.streaming) {
        return [...blocks.slice(0, -1), { ...last, content: last.content + event.delta }];
      }
      return [...endStreaming(blocks), {
        id: `${kind}:${blocks.length + 1}`, kind, content: event.delta, streaming: true, startedAt: Date.now(),
      }];
    }
    case "tool_started": {
      const phase = event.phase ?? "running";
      const existing = blocks.findIndex((block) => block.tool?.id === event.id);
      if (existing < 0) return [...endStreaming(blocks), {
        id: `tool:${event.id}`, kind: "tool", content: "",
        tool: { id: event.id, name: event.name, args: event.args, status: phase },
      }];
      const current = blocks[existing]!.tool!;
      if ((current.status !== "queued" && current.status !== "running") ||
          (phase === "queued" && current.status === "running")) return blocks;
      return blocks.map((block, index) => index === existing
        ? { ...block, tool: { ...current, name: event.name, args: event.args, status: phase } }
        : block);
    }
    case "tool_finished":
      return blocks.map((block) => block.tool?.id === event.id ? {
        ...block, content: event.content ?? block.content,
        tool: { ...block.tool, status: event.outcome,
          ...(event.details !== undefined ? { details: event.details } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        },
      } : block);
    default: return blocks;
  }
}
