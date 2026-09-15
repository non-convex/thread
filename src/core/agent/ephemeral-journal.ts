import type { Message } from "@earendil-works/pi-ai";
import type { ExecutionJournal } from "./execution-journal.js";
import { createId } from "../utils/id.js";

/** A run-local journal for agents whose trace must not become durable history. */
export class EphemeralAgentJournal implements ExecutionJournal {
  readonly executionId = createId("agent-run");
  private readonly messages: Message[];

  constructor(initialMessages: readonly Message[], private readonly agentId: string) {
    this.messages = initialMessages.map((message) => structuredClone(message));
  }

  get identity() {
    return { executionId: this.executionId, agentId: this.agentId, sessionId: null, turnId: null };
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

  // This journal retains model messages only; it has no durable tool-fact log.
  async appendToolExecution(): Promise<void> {}

  async appendToolResult(message: Message): Promise<void> {
    this.messages.push(structuredClone(message));
  }
}
