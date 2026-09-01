import type { Message } from "@earendil-works/pi-ai";
import type { ExecutionJournal, ToolExecutionFact } from "../agent/execution-journal.js";
import { createId } from "../utils/id.js";
import type { AgentTaskRepository } from "./repository.js";

export class AgentTaskJournal implements ExecutionJournal {
  readonly ready = Promise.resolve();

  constructor(
    private readonly repository: AgentTaskRepository,
    readonly executionId: string,
  ) {}

  get messages(): Message[] {
    return this.repository.projection.require(this.executionId).trace
      .filter((entry) => entry.kind === "message")
      .map((entry) => structuredClone(entry.message));
  }

  conversationMessages(): Message[] {
    return this.messages;
  }

  planAssistantEntryId(): string {
    return createId("entry");
  }

  async appendUser(content: string): Promise<void> {
    const timestamp = Date.now();
    await this.repository.append({
      type: "trace_message",
      taskId: this.executionId,
      entry: {
        kind: "message",
        entryId: createId("entry"),
        timestamp,
        message: { role: "user", content, timestamp },
      },
    }, true);
  }

  async appendAssistant(message: Message, entryId: string): Promise<void> {
    await this.repository.append({
      type: "trace_message",
      taskId: this.executionId,
      entry: { kind: "message", entryId, timestamp: message.timestamp, message: structuredClone(message) },
    }, true);
  }

  async appendToolExecution(fact: ToolExecutionFact): Promise<void> {
    await this.repository.append({
      type: "trace_tool_execution",
      taskId: this.executionId,
      entry: { kind: "tool_execution", entryId: createId("entry"), timestamp: Date.now(), fact: structuredClone(fact) },
    }, true);
  }

  async appendToolResult(message: Message): Promise<void> {
    await this.repository.append({
      type: "trace_message",
      taskId: this.executionId,
      entry: { kind: "message", entryId: createId("entry"), timestamp: message.timestamp, message: structuredClone(message) },
    });
  }
}
