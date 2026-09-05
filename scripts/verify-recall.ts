import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { SessionTreeRepository } from "../src/session-tree/repository.js";
import { SessionTreeService } from "../src/session-tree/service.js";
import { SessionRecallService } from "../src/session-recall/service.js";
import { LocalEmbedding } from "../src/session-recall/embedding.js";
import { getThreadHome } from "../src/config/thread-config.js";
import { MODEL_REVISION } from "../src/session-recall/model-assets.js";
import { Tokenizer } from "@huggingface/tokenizers";
import { recallCorpus } from "../test/fixtures/recall-corpus.js";

// Keep OS sampling in the benchmark, outside both production APIs and timed queries.
function embeddingRssMiB(): number {
  if (process.platform === "win32") {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${process.pid}' | Where-Object { $_.Name -eq 'bun.exe' } | Measure-Object -Property WorkingSetSize -Sum).Sum`],
    { encoding: "utf8", windowsHide: true });
    return Number(output.trim()) / 1024 ** 2;
  }
  const output = execFileSync("ps", ["-axo", "ppid=,rss=,command="], { encoding: "utf8" });
  return output.split("\n").reduce((sum, line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return sum + (match && Number(match[1]) === process.pid && match[3]!.includes("embedding-worker") ? Number(match[2]) / 1024 : 0);
  }, 0);
}

const directory = await mkdtemp(path.join(tmpdir(), "thread-real-recall-"));
const project = { id: "recall_verification", rootPath: path.join(directory, "中文工作区"), statePath: path.join(directory, "state") };
await mkdir(project.rootPath, { recursive: true });
const repository = await SessionTreeRepository.open(project);
const tree = new SessionTreeService(repository);
await tree.initialize();
const embedding = new LocalEmbedding();
const recall = new SessionRecallService(tree, { embedding });
const signal = AbortSignal.timeout(15 * 60_000);
try {
  const ids: string[] = [];
  for (const item of recallCorpus) {
    const turn = await tree.startTurn(item.text, "ws");
    await tree.finishTurn(turn.id, "completed");
    ids.push(turn.id);
  }
  const start = performance.now();
  await recall.search(["追加日志"], 8, signal);
  await recall.whenIdle();
  const indexMs = performance.now() - start;
  const latencies: number[] = [];
  const rankings: { query: string; rank: number | null }[] = [];
  for (const [index, item] of recallCorpus.entries()) {
    if (!item.query) continue;
    const started = performance.now();
    const result = await recall.search([item.query], 8, signal);
    latencies.push(performance.now() - started);
    assert.equal(result.semantic, "ready", result.diagnostics.join("\n"));
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.coverage.semanticTurns, recallCorpus.length);
    const rank = result.hits.findIndex((hit) => hit.turnId === ids[index]);
    rankings.push({ query: item.query, rank: rank < 0 ? null : rank + 1 });
  }
  for (const identifier of ["parseReceipt", "E_RECEIPT_9281", "src/payments/receipt.ts"]) {
    assert.equal((await recall.search([identifier], 8, signal)).hits[0]?.turnId, ids[15]);
  }
  const retrievalParentRssMiB = process.memoryUsage().rss / 1024 ** 2;
  const retrievalEmbeddingRssMiB = embeddingRssMiB();
  assert.ok(retrievalEmbeddingRssMiB > 0, "The benchmark must include the inference process's memory");
  const referenceText = "会话历史采用追加日志，旧记录会保留下来。";
  const vectors = await embedding.embed([referenceText], "passage", signal);
  // Independent Transformers.js 3.8.1 feature-extraction pipeline, pinned Q8
  // weights, "passage: " prefix, mean pooling, normalize=true, CPU, batch of one.
  const expected = [0.053179796785116196, -0.031286705285310745, 0.021085355430841446, -0.043446388095617294,
    0.08249504119157791, -0.02300015464425087, -0.010793231427669525, 0.022176267579197884];
  assert.equal(vectors[0]!.length, 384);
  assert.ok(Math.abs(Math.hypot(...vectors[0]!) - 1) < 1e-5);
  expected.forEach((value, index) => assert.ok(Math.abs(vectors[0]![index]! - value) < 0.003, "Pinned Q8 reference vector drift"));
  const mixed = await embedding.embed([referenceText, "short text"], "passage", signal);
  const batchCosine = mixed[0]!.reduce((sum, value, index) => sum + value * vectors[0]![index]!, 0);
  assert.ok(batchCosine > 0.98, "Padding or batch handling changed the embedding substantially");
  const modelDirectory = path.join(getThreadHome(), "models/multilingual-e5-small", MODEL_REVISION);
  const tokenizer = new Tokenizer(JSON.parse(await readFile(path.join(modelDirectory, "tokenizer.json"), "utf8")),
    JSON.parse(await readFile(path.join(modelDirectory, "tokenizer_config.json"), "utf8")));
  const long = "😀历史记录 LongFunctionName foo_bar /中文路径/entry.ts\n\n".repeat(180);
  const spans = await embedding.split(long, signal);
  assert.ok(spans.length > 1);
  for (const span of spans) {
    assert.equal(span.text, long.slice(span.start, span.end));
    assert.ok(tokenizer.encode(span.text, { add_special_tokens: false }).ids.length <= 480);
  }
  assert.equal(spans.at(-1)!.end, long.length);
  const whitespace = " ".repeat(40_000) + "visible text";
  const sparse = await embedding.split(whitespace, signal);
  assert.ok(sparse.length < 10, "Low-token spans must advance without repeating almost the entire chunk");
  assert.equal(sparse.at(-1)!.end, whitespace.length);
  const found = rankings.filter((item) => item.rank !== null && item.rank <= 5).length;
  latencies.sort((a, b) => a - b);
  console.log(JSON.stringify({ turns: ids.length, recallAt5: `${found}/${rankings.length}`, rankings,
    indexMs, queryP50Ms: latencies[Math.floor(latencies.length / 2)], queryMaxMs: latencies.at(-1),
    retrievalParentRssMiB, retrievalEmbeddingRssMiB,
    retrievalCombinedRssMiB: retrievalParentRssMiB + retrievalEmbeddingRssMiB,
    referenceVector: "passed", batchCosine, longTextChunks: spans.length }, null, 2));
  assert.ok(found >= 8, "At least 8/10 paraphrases must retrieve the designated turn in the first five results");
} finally {
  await recall.close(); await repository.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}
