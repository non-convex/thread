import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { SessionTreeRepository } from "../src/session-tree/repository.js";
import { SessionTreeService } from "../src/session-tree/service.js";
import { SessionRecallService } from "../src/session-recall/service.js";
import { extractDocuments, keywordFragments } from "../src/session-recall/documents.js";
import { ZvecRecallIndex } from "../src/session-recall/zvec-index.js";
import { MODEL_REVISION, prepareModel } from "../src/session-recall/model-assets.js";
import { loadThreadConfig } from "../src/config/thread-config.js";
import type { EmbeddingEngine } from "../src/session-recall/embedding.js";
import type { SessionEntry } from "../src/session-tree/model.js";

class TestEmbedding implements EmbeddingEngine {
  initialized = 0;
  passages = 0;
  queries = 0;
  async initialize(_signal: AbortSignal) { this.initialized++; }
  async split(text: string) { return [{ text, start: 0, end: text.length }]; }
  async embed(texts: string[], purpose: "query" | "passage") {
    if (purpose === "passage") this.passages += texts.length;
    else this.queries += texts.length;
    return texts.map((text) => {
      const vector = new Float32Array(384);
      vector[/日志|history|记录/.test(text) ? 0 : 1] = 1;
      return vector;
    });
  }
  async close() {}
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-recall-"));
  const project = { id: "project_test", rootPath: path.join(directory, "工作区"), statePath: path.join(directory, "state") };
  await mkdir(project.rootPath, { recursive: true });
  const repository = await SessionTreeRepository.open(project);
  const tree = new SessionTreeService(repository);
  await tree.initialize();
  const turn = async (text: string, status: "completed" | "failed" | "interrupted" = "completed") => {
    const started = await tree.startTurn(text, "workspace_test");
    await tree.appendMessage({ turnId: started.id, message: fauxAssistantMessage(fauxText(`已处理：${text}`)) });
    await tree.finishTurn(started.id, status);
    return started.id;
  };
  return { directory, project, repository, tree, turn,
    async close() { await repository.close(); await rm(directory, { recursive: true, force: true, maxRetries: 3 }); } };
}

test("Chinese BM25, exact identifiers, retained branches and current-turn exclusion", async () => {
  const f = await fixture();
  const recall = new SessionRecallService(f.tree, { semantic: false });
  try {
    const first = await f.turn("会话历史采用追加日志，旧记录会保留下来。 src/session-tree/repository.ts E_CHECKPOINT_042");
    const second = await f.turn("失败的尝试仍然保留", "failed");
    await f.tree.moveLiveTipForRewind(first);
    const keyword = await recall.search(["历史日志"]);
    assert.equal(keyword.hits[0]?.turnId, first);
    assert.ok(keyword.hits[0]?.sources.includes("keyword"));
    assert.deepEqual(keyword.diagnostics, []);
    assert.equal((await recall.search(["E_CHECKPOINT_042"])).hits[0]?.turnId, first);
    assert.equal((await recall.search(["失败的尝试"])).hits[0]?.pathStatus, "current-session-off-path");
    await f.tree.createSession();
    assert.equal((await recall.search(["失败的尝试"])).hits[0]?.pathStatus, "other-session");
    const running = await f.tree.startTurn("uniquesearchtokenzxq", "ws");
    await f.tree.appendToolExecution({ turnId: running.id, assistantEntryId: "assistant1", toolIndex: 0,
      toolCallId: "call1", toolName: "session_search", effectiveArgs: { queries: ["uniquesearchtokenzxq"] }, replay: "safe" });
    assert.equal((await recall.search(["uniquesearchtokenzxq"])).hits.length, 0);
    assert.equal(recall.read(second)?.status, "failed");
    assert.equal(recall.readPath(first, { after: 1 }).length, 1);
    await f.tree.finishTurn(running.id, "interrupted");
    assert.equal((await recall.search(["uniquesearchtokenzxq"])).hits[0]?.status, "interrupted");
  } finally { await recall.close(); await f.close(); }
});

test("one extraction policy excludes recall copies and deduplicates tool calls while preserving readback", async () => {
  const f = await fixture();
  const recall = new SessionRecallService(f.tree, { semantic: false });
  try {
    const running = await f.tree.startTurn("原始问题", "ws");
    const message = fauxAssistantMessage(fauxText("正文"));
    message.content.push({ type: "thinking", thinking: "private-thinking-marker" },
      { type: "toolCall", id: "bash1", name: "bash", arguments: { command: "exact-command" } },
      { type: "toolCall", id: "read1", name: "session_read", arguments: { turnId: "copiedturnid" } });
    const entry = await f.tree.appendMessage({ turnId: running.id, message });
    await f.tree.appendToolExecution({ turnId: running.id, assistantEntryId: entry.id, toolIndex: 1,
      toolCallId: "bash1", toolName: "bash", effectiveArgs: { command: "exact-command" }, replay: "never" });
    await f.tree.appendMessage({ turnId: running.id, message: { role: "toolResult", toolCallId: "read1", toolName: "session_read",
      content: [{ type: "text", text: "copiedrecallresult" }], isError: false, timestamp: Date.now() } });
    await f.tree.finishTurn(running.id, "completed");
    await f.tree.appendCompaction({ turnId: running.id, summary: "compactiononlymarker", retainedTurns: [{ turnId: running.id, messages: [{ role: "user", content: "retained copy", timestamp: Date.now() }] }],
      tokensBefore: 10, tokensAfter: 5, reason: "manual" });
    const docs = extractDocuments(f.tree.entriesForTurn(running.id));
    assert.equal(docs.filter((doc) => doc.kind === "tool-call").length, 1);
    assert.ok(docs.filter((doc) => doc.semantic).every((doc) => !/private-thinking|exact-command|copied/.test(doc.text)));
    assert.equal((await recall.search(["copiedrecallresult", "compactiononlymarker", "copiedturnid"])).hits.length, 0);
    assert.equal((await recall.search(["exact-command"])).hits.length, 1);
    assert.match(recall.read(running.id, { toolResults: true, thinking: true })!.text, /copiedrecallresult/);
    assert.match(recall.read(running.id, { thinking: true })!.text, /private-thinking-marker/);
  } finally { await recall.close(); await f.close(); }
});

test("incremental vectors survive restart and missing index is rebuilt", async () => {
  const f = await fixture();
  let embedding = new TestEmbedding();
  let recall = new SessionRecallService(f.tree, { embedding });
  try {
    const first = await f.turn("追加日志保存了旧记录");
    await recall.search(["history"]);
    await recall.whenIdle();
    assert.equal(embedding.passages, 2);
    const result = await recall.search(["history"]);
    assert.equal(result.hits[0]?.turnId, first);
    assert.ok(result.hits[0]?.sources.includes("semantic"));
    assert.equal(result.semantic, "ready");
    const added = await f.turn("new history");
    recall.turnFinished();
    await recall.whenIdle();
    assert.equal(embedding.passages, 4);
    assert.equal((await recall.search(["new history"])).hits[0]?.turnId, added);
    await recall.close();
    embedding = new TestEmbedding();
    recall = new SessionRecallService(f.tree, { embedding });
    await recall.search(["history"]);
    await recall.whenIdle();
    assert.equal(embedding.passages, 0);
    await recall.close();
    await rm(path.join(f.project.statePath, "session-search/semantic"), { recursive: true, force: true });
    recall = new SessionRecallService(f.tree, { embedding });
    await recall.search(["history"]);
    await recall.whenIdle();
    assert.equal(embedding.passages, 4);
    assert.deepEqual((await recall.search(["history"])).diagnostics, []);
  } finally { await recall.close(); await f.close(); }
});

test("embedding preparation failure degrades to keywords, and cancellation stays cancellation", async () => {
  const f = await fixture();
  const embedding = new TestEmbedding();
  embedding.initialize = async () => { throw new Error("model download unavailable"); };
  const recall = new SessionRecallService(f.tree, { embedding });
  try {
    await f.turn("中文检索仍然可用");
    await recall.search(["检索"]);
    await recall.whenIdle();
    const result = await recall.search(["检索"]);
    assert.equal(result.semantic, "unavailable");
    assert.ok(result.diagnostics.some((line) => line.includes("model download unavailable")));
    assert.equal(result.hits.length, 1);
    const controller = new AbortController(); controller.abort(new Error("caller cancelled"));
    await assert.rejects(recall.search(["检索"], 8, controller.signal), /caller cancelled/);
    await assert.rejects(recall.search(["  "]), /non-empty/);
  } finally { await recall.close(); await f.close(); }
});

test("partial zvec batch failure does not advance progress and retry repairs leftovers", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-recall-index-"));
  const index = await ZvecRecallIndex.open(directory, "p", "t");
  const signal = new AbortController().signal;
  const fragment = { id: "valid", turnId: "turn", sessionId: "s", entryId: "e", kind: "user" as const,
    semantic: true, text: "记录", start: 0, end: 2 };
  try {
    await assert.rejects(index.replaceTurn("semantic", "turn", "hash", [
      { ...fragment, vector: new Float32Array(384).fill(0.1) },
      { ...fragment, id: "invalid", vector: new Float32Array(3) },
    ], signal));
    assert.equal(index.has("semantic", "turn", "hash"), false);
    await index.replaceTurn("semantic", "turn", "hash", [{ ...fragment, vector: new Float32Array(384).fill(0.1) }], signal);
    assert.equal(index.has("semantic", "turn", "hash"), true);
    assert.equal((await index.query("semantic", new Float32Array(384).fill(0.1))).length, 1);
  } finally { index.close(); await rm(directory, { recursive: true, force: true }); }
});

test("long keyword chunks preserve exact source offsets, and config validates semantic flag", async () => {
  const entry = { id: "e", turnId: "t", sessionId: "s", ordinal: 0, timestamp: 0, type: "message",
    message: { role: "user", timestamp: 0, content: "😀中文\n\n".repeat(1_000) } } as SessionEntry;
  const doc = extractDocuments([entry])[0]!;
  const chunks = keywordFragments(doc);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.equal(chunk.text, doc.text.slice(chunk.start, chunk.end));
    assert.ok(chunk.text.length <= 2_000);
  }
  assert.equal(chunks.at(-1)?.end, doc.text.length);
  const edge = keywordFragments({ ...doc, text: "a".repeat(2_000) + "\n\nb" });
  assert.equal(edge[0]?.text.length, 2_000);
  const directory = await mkdtemp(path.join(tmpdir(), "thread-recall-config-"));
  try {
    const file = path.join(directory, "config.json");
    await writeFile(file, JSON.stringify({ search: { semantic: false } }));
    assert.equal((await loadThreadConfig(file))?.config.search?.semantic, false);
    await writeFile(file, JSON.stringify({ search: { semantic: "yes" } }));
    await assert.rejects(loadThreadConfig(file), /search.semantic/);
    const controller = new AbortController(); controller.abort(new Error("stop download"));
    await assert.rejects(prepareModel(controller.signal, directory), /stop download/);
    await assert.rejects(readFile(path.join(directory, "models/multilingual-e5-small/complete.json")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed and corrupt downloads release the shared cache lock without committing model files", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "thread-recall-download-"));
  const previousEndpoint = process.env.HF_ENDPOINT;
  let corrupt = false;
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;
    return corrupt ? new Response("truncated model") : new Response("offline", { status: 503 });
  } });
  try {
    process.env.HF_ENDPOINT = server.url.toString();
    const signal = AbortSignal.timeout(5_000);
    // Concurrent projects contend on the same cache; both must release on failure.
    await Promise.all([0, 1].map(() => assert.rejects(prepareModel(signal, home), /download failed \(503\)/)));
    corrupt = true;
    await assert.rejects(prepareModel(signal, home), /integrity check failed/);
    assert.equal(requests, 3);
    const directory = path.join(home, "models/multilingual-e5-small", MODEL_REVISION);
    assert.deepEqual(await readdir(directory), ["onnx"]);
    assert.deepEqual(await readdir(path.join(directory, "onnx")), []);
  } finally {
    server.stop(true);
    if (previousEndpoint === undefined) delete process.env.HF_ENDPOINT;
    else process.env.HF_ENDPOINT = previousEndpoint;
    await rm(home, { recursive: true, force: true });
  }
});

test("a preparing model never blocks keyword updates, and shutdown cancels preparation", async () => {
  const f = await fixture();
  const embedding = new TestEmbedding();
  let cancelled = false;
  embedding.initialize = (signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true });
  });
  const recall = new SessionRecallService(f.tree, { embedding });
  try {
    await f.turn("initialmarker");
    assert.equal((await recall.search(["initialmarker"])).semantic, "preparing");
    const added = await f.turn("incrementalmarker");
    recall.turnFinished();
    assert.equal((await recall.search(["incrementalmarker"])).hits[0]?.turnId, added);
    await recall.close();
    assert.equal(cancelled, true);
  } finally { await recall.close(); await f.close(); }
});

test("a failed semantic query does not disable subsequent queries", async () => {
  const f = await fixture();
  const embedding = new TestEmbedding();
  const embed = embedding.embed.bind(embedding);
  embedding.embed = async (texts, purpose) => {
    if (purpose === "query" && texts.includes("invalidquery")) throw new Error("query exceeds token limit");
    return embed(texts, purpose);
  };
  const recall = new SessionRecallService(f.tree, { embedding });
  try {
    await f.turn("历史记录");
    await recall.search(["记录"]);
    await recall.whenIdle();
    assert.equal((await recall.search(["invalidquery"])).semantic, "unavailable");
    const good = await recall.search(["history"]);
    assert.equal(good.semantic, "ready");
    assert.deepEqual(good.diagnostics, []);
    assert.ok(good.hits[0]?.sources.includes("semantic"));
  } finally { await recall.close(); await f.close(); }
});

test("invalid cache manifests rebuild and an unavailable index uses the same literal documents", async () => {
  const f = await fixture();
  let recall = new SessionRecallService(f.tree, { semantic: false });
  const indexPath = path.join(f.project.statePath, "session-search");
  try {
    const id = await f.turn("recoverablemarker");
    await recall.search(["recoverablemarker"]);
    await recall.close();
    await writeFile(path.join(indexPath, "manifest.json"), "null");
    recall = new SessionRecallService(f.tree, { semantic: false });
    const rebuilt = await recall.search(["recoverablemarker"]);
    assert.deepEqual(rebuilt.diagnostics, []);
    assert.equal(rebuilt.hits[0]?.turnId, id);
    await recall.close();
    await rm(indexPath, { recursive: true, force: true });
    await writeFile(indexPath, "not a directory");
    recall = new SessionRecallService(f.tree);
    const degraded = await recall.search(["recoverablemarker"]);
    assert.equal(degraded.hits[0]?.turnId, id);
    assert.deepEqual(degraded.hits[0]?.sources, ["literal"]);
    assert.equal(degraded.semantic, "unavailable");
    assert.match(degraded.diagnostics.join("\n"), /zvec unavailable/);
  } finally { await recall.close(); await f.close(); }
});
