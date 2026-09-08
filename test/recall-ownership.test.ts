import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { LocalEmbedding, type EmbeddingEngine } from "../src/session-recall/embedding.js";
import { SessionRecallService } from "../src/session-recall/service.js";
import { SessionTreeRepository } from "../src/session-tree/repository.js";
import { SessionTreeService } from "../src/session-tree/service.js";

async function fixture(t: TestContext): Promise<SessionTreeService> {
  const directory = await mkdtemp(path.join(tmpdir(), "thread-recall-ownership-"));
  const repository = await SessionTreeRepository.open({
    id: "recall-ownership",
    rootPath: directory,
    statePath: path.join(directory, "state"),
  });
  t.after(async () => {
    await repository.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const tree = new SessionTreeService(repository);
  await tree.initialize();
  return tree;
}

test("closing recall leaves a shared injected embedding engine usable by its host", async (t) => {
  const tree = await fixture(t);
  let closed = false;
  let closeCalls = 0;
  const embedding: EmbeddingEngine = {
    async initialize(signal) { signal.throwIfAborted(); assert.equal(closed, false); },
    async split() { return []; },
    async embed() { return []; },
    async close() { closeCalls++; closed = true; },
  };
  const first = new SessionRecallService(tree, { semantic: false, embedding });
  const second = new SessionRecallService(tree, { embedding });
  await first.close();
  await first.close();
  await embedding.initialize(new AbortController().signal);
  await second.close();
  assert.equal(closeCalls, 0);
  await embedding.initialize(new AbortController().signal);
  await embedding.close();
  assert.equal(closeCalls, 1);
});

test("recall closes the LocalEmbedding it creates exactly once", async (t) => {
  const tree = await fixture(t);
  const recall = new SessionRecallService(tree, { semantic: false });
  // Observe cleanup of this one internal engine without starting a model worker
  // or patching the global prototype used by other recall instances.
  const embedding = (recall as unknown as { embedding: EmbeddingEngine }).embedding;
  assert.ok(embedding instanceof LocalEmbedding);
  const close = embedding.close.bind(embedding);
  let closeCalls = 0;
  embedding.close = async () => { closeCalls++; await close(); };
  const closing = recall.close();
  assert.strictEqual(recall.close(), closing);
  await closing;
  assert.equal(closeCalls, 1);
});
