import type { Message } from "@earendil-works/pi-ai";
import type { ExecutionJournal, ToolExecutionFact } from "./execution-journal.js";
import { createId } from "../utils/id.js";

/** A run-local journal for agents whose trace must not become durable history. */
export class EphemeralAgentJournal implements ExecutionJournal {
  readonly ready = Promise.resolve();
  readonly executionId = createId("agent-run");
  private readonly messages: Message[];
  private readonly toolExecutions: ToolExecutionFact[] = [];

  constructor(initialMessages: readonly Message[] = []) {
    this.messages = initialMessages.map((message) => structuredClone(message));
  }

  conversationMessages(): Message[] {
    return this.messages.map((message) => structuredClone(message));
  }

  planAssistantEntryId(): string {
    return createId("entry");
  }

  async appendAssistant(message: Message): Promise<void> {
    this.messages.push(structuredClone(message));
  }

  async appendToolExecution(fact: ToolExecutionFact): Promise<void> {
    this.toolExecutions.push(structuredClone(fact));
  }

  async appendToolResult(message: Message): Promise<void> {
    this.messages.push(structuredClone(message));
  }
}
