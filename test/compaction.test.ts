import assert from "node:assert/strict";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type Context,
  type Message,
} from "@earendil-works/pi-ai";
import type { ModelClient, ModelRequestOptions } from "../src/agent/model-client.js";
import {
  ContextBuilder,
  progressSummaryMessage,
  projectedContextMessages,
  TURN_PROGRESS_PREFIX,
} from "../src/context/builder.js";
import { contextBudget } from "../src/context/budget.js";
import {
  COMPACTION_MIN_RETAINED_STEPS,
  ContextCompactionService,
  isHistorySummaryInstruction,
  isProgressSummaryInstruction,
  partitionCompactable,
  selectRetained,
} from "../src/context/compaction/index.js";
import type { CompactionEntry, RetainedTurn, SessionEntry, Turn } from "../src/session-tree/model.js";
import type { SessionTreeService } from "../src/session-tree/service.js";

class ScriptedModel implements ModelClient {
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

  async completeText(): Promise<string> {
    return "summary";
  }

  async forkComplete(): Promise<string> {
    return "summary";
  }

  /** Contexts whose trailing instruction matches a predicate. */
  matching(predicate: (text: string) => boolean): Context[] {
    return this.contexts.filter((context) => predicate(text(context.messages.at(-1)!)));
  }
}

/** Fails validation twice, then serves the script, to exercise silent retry. */
class FlakyModel extends ScriptedModel {
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

class AlwaysEmptyModel extends ScriptedModel {
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

function user(content: string, timestamp = 1): Message {
  return { role: "user", content, timestamp };
}

function toolStep(id: string, resultText: string, timestamp: number): Message[] {
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
function turnWithSteps(turnId: string, request: string, count: number, padding = 0): RetainedTurn {
  const messages: Message[] = [user(request, 1)];
  for (let index = 0; index < count; index++) {
    const body = padding > 0 ? `${"x".repeat(padding)} ${turnId}-${index}` : `${turnId}-${index}`;
    messages.push(...toolStep(`${turnId}-${index}`, body, 2 + index * 2));
  }
  return { turnId, messages };
}

function text(message: Message): string {
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

function rendered(messages: readonly Message[]): string {
  return messages.map(text).join("\n");
}

function builtFrom(turns: RetainedTurn[], previous?: CompactionEntry) {
  return {
    messages: projectedContextMessages(previous?.summary ?? "", turns, previous?.timestamp ?? 1),
    compactableTurns: turns,
    ...(previous ? { latestCompaction: previous } : {}),
  };
}

function compactionEntry(input: {
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

async function runCompaction(input: {
  turns: RetainedTurn[];
  model: ScriptedModel;
  previous?: CompactionEntry;
  turnId?: string;
}) {
  const built = builtFrom(input.turns, input.previous);
  const context: Context = { systemPrompt: "system", messages: built.messages, tools: [] };
  const budget = contextBudget(context, built.messages, 4_000);
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

test("steps are the only cut points and an in-flight batch stays whole", () => {
  const dangling = fauxToolCall("probe", { payload: "p" }, { id: "dangling" });
  const turn: RetainedTurn = {
    turnId: "turn-1",
    messages: [
      user("request"),
      ...toolStep("a", "first", 2),
      fauxAssistantMessage([dangling], { stopReason: "toolUse", timestamp: 6 }),
    ],
  };
  const units = partitionCompactable([turn]);
  assert.deepEqual(units.map((unit) => unit.kind), ["user", "step", "trailing"]);
  assert.equal(units[1]!.messages.length, 2);
  assert.equal(units[2]!.messages.length, 1);
});

test("retention keeps the step floor and reports a mid-turn cut", () => {
  const turn = turnWithSteps("turn-long", "one long task", 9, 20_000);
  const units = partitionCompactable([turn]);
  const plan = selectRetained(units, 0);

  const retainedSteps = plan.retained.filter((unit) => unit.kind === "step").length;
  assert.equal(retainedSteps, COMPACTION_MIN_RETAINED_STEPS);
  assert.equal(plan.retained[0]!.kind, "step");
  assert.equal(plan.partialTurnId, "turn-long");
  assert.equal(plan.summarized.some((unit) => unit.kind === "user"), true);
});

test("a cut on a turn boundary needs no progress summary", () => {
  const turns = [
    turnWithSteps("turn-1", "first", 3, 20_000),
    turnWithSteps("turn-2", "second", 5, 20_000),
  ];
  const plan = selectRetained(partitionCompactable(turns), 0);
  assert.equal(plan.partialTurnId, undefined);
  assert.equal(plan.retained[0]!.kind, "user");
  assert.equal(plan.retained[0]!.turnId, "turn-2");
});

test("the step floor wins over the token budget", () => {
  const turn = turnWithSteps("turn-huge", "huge task", 7, 120_000);
  const plan = selectRetained(partitionCompactable([turn]), 0);
  assert.equal(plan.retained.filter((unit) => unit.kind === "step").length, COMPACTION_MIN_RETAINED_STEPS);
});

test("a short conversation is left alone", async () => {
  const turns = [turnWithSteps("turn-1", "small", 2)];
  const model = new ScriptedModel();
  const { result } = await runCompaction({ turns, model });
  assert.equal(result.compacted, false);
  assert.equal(model.contexts.length, 0);
});

test("history summary runs whenever there is anything to summarize", async () => {
  const turns = [
    turnWithSteps("turn-1", "first", 4, 20_000),
    turnWithSteps("turn-2", "second", 5, 20_000),
  ];
  const model = new ScriptedModel(["## Current project state\n\nrolled forward"]);
  const { result, tree } = await runCompaction({ turns, model });

  assert.equal(result.compacted, true);
  if (!result.compacted) return;
  assert.equal(result.historySummary, "## Current project state\n\nrolled forward");
  assert.equal(result.progressSummary, undefined);
  assert.equal(tree.appended[0]!.progressSummary, undefined);
  assert.equal(model.matching(isHistorySummaryInstruction).length, 1);
  assert.equal(model.matching(isProgressSummaryInstruction).length, 0);
});

test("a mid-turn cut copies the request and inserts a progress checkpoint", async () => {
  const turns = [turnWithSteps("turn-long", "ORIGINAL REQUEST", 9, 20_000)];
  const model = new ScriptedModel(["## Current project state\n\nhistory", "did steps 0 through 3"]);
  const { result, tree } = await runCompaction({ turns, model });

  assert.equal(result.compacted, true);
  if (!result.compacted) return;
  assert.equal(result.progressSummary, "did steps 0 through 3");
  assert.equal(tree.appended[0]!.progressSummary, "did steps 0 through 3");

  // The stored projection still begins with the copied user request.
  const stored = tree.appended[0]!.retainedTurns;
  assert.equal(stored.length, 1);
  assert.equal(text(stored[0]!.messages[0]!), "ORIGINAL REQUEST");

  // Both calls happened, and the progress call carried only that turn's trajectory.
  assert.equal(model.matching(isHistorySummaryInstruction).length, 1);
  const progressContexts = model.matching(isProgressSummaryInstruction);
  assert.equal(progressContexts.length, 1);
  assert.equal(progressContexts[0]!.tools?.length, 0);
  assert.match(rendered(progressContexts[0]!.messages), /ORIGINAL REQUEST/);
});

test("the projected context orders history, request, checkpoint, then steps", async () => {
  const turns = [turnWithSteps("turn-long", "ORIGINAL REQUEST", 9, 20_000)];
  const model = new ScriptedModel(["## Long-term memory\n\n- history line", "progress line"]);
  const { tree } = await runCompaction({ turns, model });

  const entry = tree.appended[0]!;
  const projected = projectedContextMessages(entry.summary, entry.retainedTurns, 500);
  const body = rendered(projected);
  assert.ok(body.indexOf("history line") < body.indexOf("ORIGINAL REQUEST"));

  // The retained tail is verbatim; the earliest steps are gone.
  assert.match(body, /turn-long-8/);
  assert.doesNotMatch(body, /turn-long-0\b/);
});

test("the progress summary rolls forward from its own previous output", async () => {
  const turns = [turnWithSteps("turn-long", "ORIGINAL REQUEST", 9, 20_000)];
  const previous = compactionEntry({
    turns,
    summary: "## Current project state\n\nolder history",
    progressSummary: "EARLIER PROGRESS TEXT",
  });
  const model = new ScriptedModel(["## Current project state\n\nnewer history", "updated progress"]);
  await runCompaction({ turns, model, previous });

  const progressContext = model.matching(isProgressSummaryInstruction)[0]!;
  const instruction = text(progressContext.messages.at(-1)!);
  assert.match(instruction, /EARLIER PROGRESS TEXT/);
  assert.match(instruction, /Update it with the newer work instead of copying it/);
});

test("a summary that fails validation is retried silently", async () => {
  const turns = [
    turnWithSteps("turn-1", "first", 4, 20_000),
    turnWithSteps("turn-2", "second", 5, 20_000),
  ];
  const model = new FlakyModel(["## Current project state\n\nthird attempt wins"]);
  const { result } = await runCompaction({ turns, model });

  assert.equal(result.compacted, true);
  if (!result.compacted) return;
  assert.equal(result.historySummary, "## Current project state\n\nthird attempt wins");
  assert.equal(model.contexts.length, 3);
});

test("exhausting the retries fails the compaction instead of dropping history", async () => {
  const turns = [
    turnWithSteps("turn-1", "first", 4, 20_000),
    turnWithSteps("turn-2", "second", 5, 20_000),
  ];
  await assert.rejects(
    runCompaction({ turns, model: new AlwaysEmptyModel() }),
    /History summary failed after 3 attempts/,
  );
});

test("compaction refuses a target that is not the newest projection", async () => {
  const turns = [
    turnWithSteps("turn-1", "first", 4, 20_000),
    turnWithSteps("turn-2", "second", 5, 20_000),
  ];
  await assert.rejects(
    runCompaction({ turns, model: new ScriptedModel(["history"]), turnId: "turn-1" }),
    /is not the newest context projection/,
  );
});

test("the builder projects the newest compaction and appends only later entries", () => {
  const turn: Turn = {
    id: "turn",
    sessionId: "session",
    parentTurnId: null,
    userEntryId: "user-entry",
    workspaceStateId: "state",
    status: "completed",
    startedAt: 1,
    finishedAt: 10,
  };
  const retained: RetainedTurn = {
    turnId: turn.id,
    messages: [user("copied request"), ...toolStep("kept", "kept result", 2)],
  };
  const compaction: CompactionEntry = {
    id: "compact",
    sessionId: "session",
    turnId: turn.id,
    ordinal: 3,
    timestamp: 5,
    type: "compaction",
    summary: "historical memory",
    retainedTurns: [retained],
    tokensBefore: 10_000,
    tokensAfter: 2_000,
    reason: "threshold",
    progressSummary: "durable progress",
  };
  const appended = toolStep("after", "new result", 6);
  const entries: SessionEntry[] = [
    { id: "user-entry", sessionId: "session", turnId: turn.id, ordinal: 0, timestamp: 1, type: "message", message: user("copied request") },
    { id: "raw-assistant", sessionId: "session", turnId: turn.id, ordinal: 1, timestamp: 2, type: "message", message: fauxAssistantMessage(fauxText("raw old work")) },
    compaction,
    { id: "new-assistant", sessionId: "session", turnId: turn.id, ordinal: 4, timestamp: 6, type: "message", message: appended[0]! },
    { id: "new-result", sessionId: "session", turnId: turn.id, ordinal: 5, timestamp: 7, type: "message", message: appended[1]! },
  ];
  const tree = {
    livePath: () => [turn],
    pathToTurn: () => [turn],
    entriesForTurn: () => structuredClone(entries),
  } as unknown as SessionTreeService;

  const built = new ContextBuilder(tree).build();
  const body = rendered(built.messages);
  assert.match(body, /historical memory/);
  assert.match(body, /copied request/);
  assert.match(body, /new result/);
  assert.doesNotMatch(body, /raw old work/);
  assert.equal(built.latestCompaction?.progressSummary, "durable progress");
});

test("the rebuilt context replays the progress checkpoint after the copied request", () => {
  const turn: Turn = {
    id: "turn",
    sessionId: "session",
    parentTurnId: null,
    userEntryId: "user-entry",
    workspaceStateId: "state",
    status: "completed",
    startedAt: 1,
    finishedAt: 10,
  };
  const retained: RetainedTurn = {
    turnId: turn.id,
    messages: [user("COPIED REQUEST"), ...toolStep("kept", "kept result", 2)],
  };
  const compaction: CompactionEntry = {
    id: "compact",
    sessionId: "session",
    turnId: turn.id,
    ordinal: 2,
    timestamp: 5,
    type: "compaction",
    summary: "HISTORY DOC",
    retainedTurns: [retained],
    tokensBefore: 10_000,
    tokensAfter: 2_000,
    reason: "threshold",
    progressSummary: "PROGRESS DOC",
  };
  const tree = {
    livePath: () => [turn],
    pathToTurn: () => [turn],
    entriesForTurn: () =>
      structuredClone([
        {
          id: "user-entry",
          sessionId: "session",
          turnId: turn.id,
          ordinal: 0,
          timestamp: 1,
          type: "message",
          message: user("COPIED REQUEST"),
        },
        compaction,
      ]),
  } as unknown as SessionTreeService;

  const built = new ContextBuilder(tree).build();
  const body = rendered(built.messages);

  // The checkpoint must be present, and sit between the request and the steps.
  assert.match(body, /PROGRESS DOC/);
  assert.ok(body.indexOf("HISTORY DOC") < body.indexOf("COPIED REQUEST"));
  assert.ok(body.indexOf("COPIED REQUEST") < body.indexOf("PROGRESS DOC"));
  assert.ok(body.indexOf("PROGRESS DOC") < body.indexOf("kept result"));
});

test("compaction measures the same projection the builder later replays", async () => {
  const turns = [turnWithSteps("turn-long", "ORIGINAL REQUEST", 9, 20_000)];
  const model = new ScriptedModel(["HISTORY DOC", "PROGRESS DOC"]);
  const { result, tree } = await runCompaction({ turns, model });
  assert.equal(result.compacted, true);
  if (!result.compacted) return;

  const entry = tree.appended[0]!;
  const replayed = projectedContextMessages(
    entry.summary,
    entry.retainedTurns,
    500,
    entry.progressSummary,
  );
  const body = rendered(replayed);
  assert.match(body, /HISTORY DOC/);
  assert.match(body, /PROGRESS DOC/);
  assert.ok(body.indexOf("ORIGINAL REQUEST") < body.indexOf("PROGRESS DOC"));
});

test("the progress checkpoint text tells the model to continue without re-asking", async () => {
  const turns = [turnWithSteps("turn-long", "ORIGINAL REQUEST", 9, 20_000)];
  const model = new ScriptedModel(["history", "progress"]);
  const { tree } = await runCompaction({ turns, model });
  assert.equal(tree.appended[0]!.progressSummary, "progress");

  const message = progressSummaryMessage("progress", 1);
  const body = text(message);
  assert.match(body, new RegExp(TURN_PROGRESS_PREFIX.replace(/[[\]]/g, "\\$&")));
  assert.match(body, /without acknowledging this checkpoint/);
});
