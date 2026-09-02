import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  Type,
  type AssistantMessage,
  type Context,
  type Message,
} from "@earendil-works/pi-ai";
import type { ModelClient, ModelRequestOptions } from "../src/agent/model-client.js";
import { ThreadApp } from "../src/app.js";
import {
  isHistorySummaryInstruction,
  isProgressSummaryInstruction,
} from "../src/context/compaction/index.js";
import { singletonResource } from "../src/tools/execution.js";
import type { AgentTool } from "../src/tools/types.js";

const HISTORY_REPLY = "## Current project state\n\ncompacted by the integration test";
const PROGRESS_REPLY = "earlier steps of this turn probed the workspace";

function messageText(message: Message): string {
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

function contextText(context: Context): string {
  return context.messages.map(messageText).join("\n");
}

/**
 * Emits a bounded number of large tool steps, then stops. Summary requests are
 * recognized by their trailing instruction and answered with scripted prose.
 */
class BigStepModel implements ModelClient {
  readonly modelId = "integration-compaction";
  readonly providerId = "test";
  readonly contextWindow = 30_000;
  readonly maxOutputTokens = 2_000;
  readonly reasoning = false;
  readonly regularContexts: Context[] = [];
  readonly historyContexts: Context[] = [];
  readonly progressContexts: Context[] = [];
  private steps = 0;

  constructor(private readonly maxSteps: number) {}

  async stream(context: Context, _options: ModelRequestOptions): Promise<AssistantMessage> {
    const instruction = messageText(context.messages.at(-1)!);
    if (isHistorySummaryInstruction(instruction)) {
      this.historyContexts.push(structuredClone(context));
      return fauxAssistantMessage(fauxText(HISTORY_REPLY));
    }
    if (isProgressSummaryInstruction(instruction)) {
      this.progressContexts.push(structuredClone(context));
      return fauxAssistantMessage(fauxText(PROGRESS_REPLY));
    }
    this.regularContexts.push(structuredClone(context));
    if (this.steps >= this.maxSteps) return fauxAssistantMessage(fauxText("done"));
    this.steps += 1;
    return fauxAssistantMessage(
      [fauxToolCall("bulk", { index: this.steps }, { id: `call-${this.steps}` })],
      { stopReason: "toolUse" },
    );
  }

  async completeText(): Promise<string> {
    return HISTORY_REPLY;
  }

  async forkComplete(): Promise<string> {
    return HISTORY_REPLY;
  }
}

function bulkTool(marker: string): AgentTool<{ index: number }> {
  return {
    name: "bulk",
    description: "Return a deliberately large result for compaction testing",
    parameters: Type.Object({ index: Type.Number() }),
    replay: "safe",
    execution: {
      effect: "read",
      mode: "parallel",
      resources: (args) => singletonResource("bulk", String(args.index), "read"),
    },
    async execute(args) {
      return {
        // A trailing space keeps `chunk 1 ` from also matching `chunk 10`.
        content: `${marker.repeat(12_000)} chunk ${args.index} `,
        isError: false,
      };
    },
  };
}

async function withThreadHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.THREAD_HOME;
  process.env.THREAD_HOME = home;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.THREAD_HOME;
    else process.env.THREAD_HOME = previous;
  }
}

async function fixture(): Promise<{ root: string; home: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-compaction-"));
  const root = path.join(directory, "project");
  const home = path.join(directory, "thread-home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  return {
    root,
    home,
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

test("a long turn compacts mid-turn and keeps working from the checkpoint", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);

  await withThreadHome(values.home, async () => {
    const model = new BigStepModel(14);
    const app = await ThreadApp.open({
      rootPath: values.root,
      model,
      skills: { skills: [], diagnostics: [] },
    });
    try {
      app.tools.register(bulkTool("z") as AgentTool);

      const outcome = await app.handleInput("please churn through the workspace", {
        signal: new AbortController().signal,
      });
      assert.equal(outcome.kind, "turn");
      if (outcome.kind !== "turn") return;
      assert.equal(outcome.result.outcome, "completed");

      const compactions = app.sessionTree
        .livePath()
        .flatMap((turn) => app.sessionTree.entriesForTurn(turn.id))
        .filter((entry) => entry.type === "compaction");
      assert.ok(compactions.length >= 1, "expected at least one compaction entry");

      const latest = compactions.at(-1)!;
      assert.equal(latest.type, "compaction");
      if (latest.type !== "compaction") return;
      assert.equal(latest.summary, HISTORY_REPLY);
      assert.ok(latest.tokensAfter < latest.tokensBefore);

      // Every stored projection begins with a user request, even when the cut
      // landed mid-turn and the request had to be copied in.
      assert.ok(latest.retainedTurns.length >= 1);
      assert.equal(latest.retainedTurns[0]!.messages[0]!.role, "user");

      // Only one user turn exists, so the cut was necessarily mid-turn.
      assert.equal(latest.progressSummary, PROGRESS_REPLY);
      assert.ok(model.progressContexts.length >= 1);
      assert.ok(model.historyContexts.length >= 1);
      assert.equal(model.progressContexts[0]!.tools?.length, 0);

      // Find a request issued after the first compaction: it must carry both
      // summaries and the copied request, and must have dropped early raw output.
      const afterCompaction = model.regularContexts.find((context) => {
        const body = contextText(context);
        return body.includes(HISTORY_REPLY) && body.includes(PROGRESS_REPLY);
      });
      assert.ok(afterCompaction, "expected a request built from the compacted projection");
      const body = contextText(afterCompaction);
      assert.ok(body.includes("please churn through the workspace"), "copied request is missing");
      assert.ok(!body.includes("chunk 1 "), "earliest raw tool output should be gone");

      assert.deepEqual(await app.fsck(), []);
    } finally {
      await app.close();
    }
  });
});

test("every context stays protocol-valid across compaction", async (t) => {
  const values = await fixture();
  t.after(values.cleanup);

  await withThreadHome(values.home, async () => {
    const model = new BigStepModel(7);
    const app = await ThreadApp.open({
      rootPath: values.root,
      model,
      skills: { skills: [], diagnostics: [] },
    });
    try {
      app.tools.register(bulkTool("q") as AgentTool);
      await app.handleInput("churn again", { signal: new AbortController().signal });

      // A cut that split a tool batch would leave a result with no matching call.
      for (const context of model.regularContexts) {
        const callIds = new Set<string>();
        const resultIds = new Set<string>();
        for (const message of context.messages) {
          if (message.role === "assistant") {
            for (const block of message.content) {
              if (block.type === "toolCall") callIds.add(block.id);
            }
          }
          if (message.role === "toolResult") resultIds.add(message.toolCallId);
        }
        for (const resultId of resultIds) {
          assert.ok(callIds.has(resultId), `orphaned tool result ${resultId}`);
        }
      }
    } finally {
      await app.close();
    }
  });
});
