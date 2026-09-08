import { fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage, type Context, type Message } from "@earendil-works/pi-ai";
import type { ModelClient, ModelRequestOptions } from "../../src/agent/model-client.js";
import { projectedContextMessages } from "../../src/context/builder.js";
import { contextBudget } from "../../src/context/budget.js";
import { ContextCompactionService } from "../../src/context/compaction/index.js";
import type { CompactionEntry, RetainedTurn } from "../../src/session-tree/model.js";
import type { SessionTreeService } from "../../src/session-tree/service.js";

export class ScriptedModel implements ModelClient {
  readonly modelId = "compaction-test";
  readonly providerId = "test";
  readonly contextWindow = 100_000;
  readonly maxOutputTokens = 4_000;
  readonly reasoning = false;
  readonly contexts: Context[] = [];

  constructor(private readonly replies: string[] = []) {}

  async stream(context: Context, _options: ModelRequestOptions): Promise<AssistantMessage> {
    this.contexts.push(structuredClone(context));
    const reply = this.replies.shift();
    // Strict: an unscripted call is a test defect, not a default.
    if (reply === undefined) throw new Error(`unscripted model call #${this.contexts.length}`);
    return fauxAssistantMessage(fauxText(reply));
  }

  /** Contexts whose trailing instruction matches a predicate. */
  matching(predicate: (text: string) => boolean): Context[] {
    return this.contexts.filter((context) => predicate(text(context.messages.at(-1)!)));
  }
}

/** Fails validation twice, then serves the script, to exercise silent retry. */
export class FlakyModel extends ScriptedModel {
  private attempts = 0;

  override async stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage> {
    this.attempts += 1;
    if (this.attempts <= 2) {
      this.contexts.push(structuredClone(context));
      return fauxAssistantMessage(fauxText("   "));
    }
    return super.stream(context, options);
  }
}

export class AlwaysEmptyModel extends ScriptedModel {
  override async stream(context: Context, _options: ModelRequestOptions): Promise<AssistantMessage> {
    this.contexts.push(structuredClone(context));
    return fauxAssistantMessage(fauxText(""));
  }
}

type AppendInput = Parameters<SessionTreeService["appendCompaction"]>[0];

class CapturingTree {
  readonly appended: AppendInput[] = [];

  async appendCompaction(input: AppendInput): Promise<CompactionEntry> {
    this.appended.push(structuredClone(input));
    return {
      id: `compaction:${this.appended.length}`,
      sessionId: "session",
      turnId: input.turnId,
      ordinal: 99 + this.appended.length,
      timestamp: 1_000 + this.appended.length,
      type: "compaction",
      ...structuredClone(input),
    };
  }
}

export function user(content: string, timestamp = 1): Message {
  return { role: "user", content, timestamp };
}

export function toolStep(id: string, resultText: string, timestamp: number): Message[] {
  const call = fauxToolCall("probe", { id }, { id: `call-${id}` });
  return [
    fauxAssistantMessage([call], { stopReason: "toolUse", timestamp }),
    {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: resultText }],
      isError: false,
      timestamp: timestamp + 1,
    },
  ];
}

/** A turn with `count` complete steps, each result padded to `padding` chars. */
export function turnWithSteps(turnId: string, request: string, count: number, padding = 0): RetainedTurn {
  const messages: Message[] = [user(request, 1)];
  for (let index = 0; index < count; index++) {
    const body = padding > 0 ? `${"x".repeat(padding)} ${turnId}-${index}` : `${turnId}-${index}`;
    messages.push(...toolStep(`${turnId}-${index}`, body, 2 + index * 2));
  }
  return { turnId, messages };
}

export function text(message: Message): string {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  }
  if (message.role === "toolResult") {
    return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  }
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      return JSON.stringify(block.arguments);
    })
    .join("\n");
}

export function rendered(messages: readonly Message[]): string {
  return messages.map(text).join("\n");
}

export function builtFrom(turns: RetainedTurn[], previous?: CompactionEntry) {
  return {
    messages: projectedContextMessages(
      previous?.summary ?? "",
      turns,
      previous?.timestamp ?? 1,
      previous?.progressSummary,
    ),
    compactableTurns: turns,
    ...(previous ? { latestCompaction: previous } : {}),
  };
}

export function compactionEntry(input: {
  turns: RetainedTurn[];
  summary: string;
  progressSummary?: string;
}): CompactionEntry {
  return {
    id: "previous-compaction",
    sessionId: "session",
    turnId: input.turns.at(-1)!.turnId,
    ordinal: 10,
    timestamp: 10,
    type: "compaction",
    summary: input.summary,
    retainedTurns: structuredClone(input.turns),
    tokensBefore: 80_000,
    tokensAfter: 40_000,
    reason: "threshold",
    ...(input.progressSummary ? { progressSummary: input.progressSummary } : {}),
  };
}

export async function runCompaction(input: {
  turns: RetainedTurn[];
  model: ScriptedModel;
  previous?: CompactionEntry;
  turnId?: string;
}) {
  const built = builtFrom(input.turns, input.previous);
  const context: Context = {
    systemPrompt: "MAIN_AGENT_SYSTEM_PROMPT_SENTINEL",
    messages: built.messages,
    tools: [],
  };
  const budget = contextBudget(context, built.messages);
  const tree = new CapturingTree();
  const service = new ContextCompactionService(tree as unknown as SessionTreeService, input.model);
  const result = await service.compact({
    built,
    context,
    turnId: input.turnId ?? input.turns.at(-1)!.turnId,
    reason: "manual",
    signal: new AbortController().signal,
    systemTokens: budget.overheadTokens,
    tokensBefore: budget.requestTokens,
  });
  return { result, tree, built, service, budget };
}
