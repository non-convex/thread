import type { Message } from "@earendil-works/pi-ai";
import type { SessionTreeService } from "../session-tree/service.js";
import type { AgentTool } from "../tools/types.js";

export interface ToolExecutionFact {
  assistantEntryId: string;
  toolIndex: number;
  toolCallId: string;
  toolName: string;
  effectiveArgs: Record<string, unknown>;
  replay: AgentTool["replay"];
}

/** The smallest durable surface shared by parent turns and child tasks. */
export interface ExecutionJournal {
  readonly executionId: string;
  readonly ready: Promise<unknown>;
  conversationMessages(): Message[];
  planAssistantEntryId(): string;
  appendAssistant(message: Message, entryId: string): Promise<void>;
  appendToolExecution(fact: ToolExecutionFact): Promise<void>;
  appendToolResult(message: Message): Promise<void>;
}

export class SessionTurnJournal implements ExecutionJournal {
  constructor(
    private readonly tree: SessionTreeService,
    readonly executionId: string,
    readonly ready: Promise<unknown>,
  ) {}

  planAssistantEntryId(): string {
    return this.tree.planMessageEntry(this.executionId).id;
  }

  conversationMessages(): Message[] {
    return this.tree.messagesForTurn(this.executionId);
  }

  async appendAssistant(message: Message, entryId: string): Promise<void> {
    await this.tree.appendMessage({ turnId: this.executionId, message, entryId }, true);
  }

  async appendToolExecution(fact: ToolExecutionFact): Promise<void> {
    await this.tree.appendToolExecution({ turnId: this.executionId, ...fact });
  }

  async appendToolResult(message: Message): Promise<void> {
    await this.tree.appendMessage({ turnId: this.executionId, message });
  }
}
