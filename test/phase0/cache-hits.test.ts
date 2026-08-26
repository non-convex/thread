import type { AssistantMessage, Message, StopReason, Usage } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import test from "node:test";
import { accumulateCacheHits, cacheHitPercent, cacheHitTotals } from "../../src/utils/estimate.js";
import { cacheHitLabel } from "../../src/ui/terminal/session-screen.js";

function usage(parts: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): Usage {
  const input = parts.input ?? 0;
  const output = parts.output ?? 0;
  const cacheRead = parts.cacheRead ?? 0;
  const cacheWrite = parts.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(parts: Parameters<typeof usage>[0], stopReason: StopReason = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "faux",
    usage: usage(parts),
    stopReason,
    timestamp: 1,
  };
}

test("cache hit totals exclude output and count writes as misses", () => {
  const totals = cacheHitTotals(usage({ input: 200, output: 5_000, cacheRead: 700, cacheWrite: 100 }));
  assert.deepEqual(totals, { cacheRead: 700, missed: 300 });
  // Output would have dragged a totalTokens-based denominator down to 12%.
  assert.equal(cacheHitPercent(totals), 70);
});

test("a context without reported usage has no hit rate rather than zero percent", () => {
  assert.equal(cacheHitPercent({ cacheRead: 0, missed: 0 }), null);
  assert.equal(accumulateCacheHits([]).cacheRead, 0);
  assert.equal(cacheHitPercent(accumulateCacheHits([])), null);
  assert.equal(cacheHitLabel(null), "cache —");
  assert.equal(cacheHitLabel(0), "cache 0%");
});

test("accumulating weights every response by its own prompt size", () => {
  const messages: Message[] = [
    // A tiny first request that misses entirely, then a large one that mostly hits.
    assistant({ input: 10, cacheWrite: 90 }),
    assistant({ input: 100, cacheRead: 9_800, cacheWrite: 100 }),
  ];
  const totals = accumulateCacheHits(messages);
  assert.deepEqual(totals, { cacheRead: 9_800, missed: 300 });
  assert.equal(cacheHitPercent(totals), 97);
  // Averaging the two percentages would have reported 49% instead.
});

test("aborted and errored responses stay out of the totals", () => {
  const messages: Message[] = [
    assistant({ input: 100, cacheRead: 900 }),
    assistant({ input: 5_000 }, "aborted"),
    assistant({ input: 5_000 }, "error"),
  ];
  assert.equal(cacheHitPercent(accumulateCacheHits(messages)), 90);
});

test("providers that never report writes still yield a usable rate", () => {
  // OpenAI-compatible responses fold every miss into `input`.
  assert.equal(cacheHitPercent(cacheHitTotals(usage({ input: 250, cacheRead: 750, output: 400 }))), 75);
});
