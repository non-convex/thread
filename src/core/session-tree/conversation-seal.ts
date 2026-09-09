import type { Api, AssistantMessage, Message, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { TurnStatus } from "./model.js";

export const INTERRUPTED_TOOL_RESULT = "Interrupted by user";

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function unmatchedToolCalls(messages: readonly Message[]): ToolCall[] {
  const pending = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") pending.set(block.id, block);
      }
    }
    if (message.role === "toolResult") pending.delete(message.toolCallId);
  }
  return [...pending.values()];
}

export function needsPlaceholderAssistant(messages: readonly Message[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "assistant") return false;
    if (message.role === "user") return true;
  }
  return messages.length === 0;
}

export function abortedToolResult(call: Pick<ToolCall, "id" | "name">, text: string): Message {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    details: { raw: { content: text, isError: true } },
    isError: true,
    timestamp: Date.now(),
  };
}

export function toolResultTextFor(status: Exclude<TurnStatus, "running">, error?: Error): string {
  if (status === "interrupted") return INTERRUPTED_TOOL_RESULT;
  return error?.message?.trim() || "Turn failed before this tool finished";
}

export function placeholderAssistant(input: {
  messages: readonly Message[];
  status: Exclude<TurnStatus, "running">;
  error?: Error;
}): AssistantMessage {
  const prior = [...input.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
  const failedText = input.status === "failed" ? input.error?.message?.trim() : undefined;
  return {
    role: "assistant",
    content: [{ type: "text", text: failedText ?? "" }],
    api: (prior?.api ?? "openai-completions") as Api,
    provider: prior?.provider ?? "thread",
    model: prior?.model ?? "unknown",
    usage: structuredClone(EMPTY_USAGE),
    stopReason: input.status === "interrupted" ? "aborted" : "error",
    ...(input.error ? { errorMessage: input.error.message } : {}),
    timestamp: Date.now(),
  };
}
