import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ZVecCollection, ZVecStatus } from "@zvec/zvec";
import { yieldToEventLoop } from "../utils/async.js";
import { CHUNK_VERSION } from "./documents.js";
import { EMBEDDING_DIMENSION, MODEL_IDENTITY } from "./model-assets.js";
import { atomicJson } from "../utils/atomic-json.js";
import type { EmbeddedFragment, RecallFragment } from "./types.js";

type Kind = "keyword" | "semantic";
interface Progress { hash: string; count: number }
interface Manifest {
  projectId: string;
  treeId: string;
  chunkVersion: number;
  model: string;
  keyword: Record<string, Progress>;
  semantic: Record<string, Progress>;
}

let native: Promise<typeof import("@zvec/zvec")> | undefined;
function loadNative(): Promise<typeof import("@zvec/zvec")> {
  return native ??= import("@zvec/zvec").then((zvec) => {
    zvec.ZVecInitialize({ queryThreads: 2, optimizeThreads: 2, logLevel: zvec.ZVecLogLevel.ERROR });
    return zvec;
  });
}

function check(status: ZVecStatus): void {
  if (!status.ok) throw new Error(`zvec ${status.code}: ${status.message}`);
}

/** One owner per project, serialized by SessionRecallService. No source-of-truth data. */
export class ZvecRecallIndex {
  private constructor(
    private readonly directory: string,
    private readonly zvec: Awaited<ReturnType<typeof loadNative>>,
    private manifest: Manifest,
    private readonly collections: Record<Kind, ZVecCollection>,
  ) {}

  static async open(directory: string, projectId: string, treeId: string): Promise<ZvecRecallIndex> {
    const zvec = await loadNative();
    await mkdir(directory, { recursive: true });
    let manifest: Manifest | undefined;
    try {
      const value = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as Manifest;
      if (value && value.projectId === projectId && value.treeId === treeId && value.chunkVersion === CHUNK_VERSION &&
          typeof value.model === "string" && [value.keyword, value.semantic].every((progress) =>
            progress && typeof progress === "object" && !Array.isArray(progress) && Object.values(progress).every((entry) =>
              entry && typeof entry.hash === "string" && Number.isSafeInteger(entry.count) && entry.count >= 0))) {
        manifest = value;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (!manifest) {
      manifest = { projectId, treeId, chunkVersion: CHUNK_VERSION, model: MODEL_IDENTITY, keyword: {}, semantic: {} };
      for (const kind of ["keyword", "semantic"] as const) await rm(path.join(directory, kind), { recursive: true, force: true });
    } else if (manifest.model !== MODEL_IDENTITY) {
      await rm(path.join(directory, "semantic"), { recursive: true, force: true });
      manifest.semantic = {};
      manifest.model = MODEL_IDENTITY;
    }
    const opened: Partial<Record<Kind, ZVecCollection>> = {};
    try {
      for (const kind of ["keyword", "semantic"] as const) {
        const collectionPath = path.join(directory, kind);
        let collection: ZVecCollection | undefined;
        try {
          if (await stat(collectionPath).then(() => true, () => false)) {
            collection = zvec.ZVecOpen(collectionPath);
            const expected = Object.values(manifest[kind]).reduce((sum, item) => sum + item.count, 0);
            if (collection.stats.docCount < expected) throw new Error("Index progress exceeds stored documents");
          }
        } catch {
          collection?.closeSync();
          collection = undefined;
        }
        if (!collection) {
          await rm(collectionPath, { recursive: true, force: true });
          manifest[kind] = {};
          collection = zvec.ZVecCreateAndOpen(collectionPath, new zvec.ZVecCollectionSchema({
            name: kind,
            fields: [
              { name: "text", dataType: zvec.ZVecDataType.STRING, ...(kind === "keyword" ? {
                indexParams: { indexType: zvec.ZVecIndexType.FTS, tokenizerName: "jieba", filters: ["lowercase"] },
              } : {}) },
              { name: "turnId", dataType: zvec.ZVecDataType.STRING },
              { name: "payload", dataType: zvec.ZVecDataType.STRING },
            ],
            ...(kind === "semantic" ? { vectors: [{
              name: "embedding", dataType: zvec.ZVecDataType.VECTOR_FP32, dimension: EMBEDDING_DIMENSION,
              indexParams: { indexType: zvec.ZVecIndexType.FLAT, metricType: zvec.ZVecMetricType.COSINE },
            }] } : {}),
          }));
        }
        opened[kind] = collection;
      }
      const index = new ZvecRecallIndex(directory, zvec, manifest, opened as Record<Kind, ZVecCollection>);
      await index.save();
      return index;
    } catch (error) {
      for (const collection of Object.values(opened)) collection.closeSync();
      throw error;
    }
  }

  has(kind: Kind, turnId: string, hash: string): boolean { return this.manifest[kind][turnId]?.hash === hash; }

  async replaceTurn(kind: Kind, turnId: string, hash: string, fragments: readonly (RecallFragment | EmbeddedFragment)[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const collection = this.collections[kind];
    // Clearing the previous attempt also removes leftovers after a partial batch failure.
    check(collection.deleteByFilterSync(`turnId = '${turnId.replace(/'/g, "''")}'`));
    for (let offset = 0; offset < fragments.length; offset += 64) {
      signal.throwIfAborted();
      const docs = fragments.slice(offset, offset + 64).map((item) => {
        const { vector, ...payload } = item as EmbeddedFragment;
        return { id: item.id, fields: { text: item.text, turnId, payload: JSON.stringify(payload) },
          ...(kind === "semantic" ? { vectors: { embedding: vector } } : {}) };
      });
      const statuses = collection.upsertSync(docs);
      if (statuses.length !== docs.length) throw new Error("zvec returned incomplete batch statuses");
      for (const status of statuses) check(status);
      await yieldToEventLoop();
    }
    // The Node binding has no flush API. Closing is its durability barrier; progress follows it.
    collection.closeSync();
    this.collections[kind] = this.zvec.ZVecOpen(path.join(this.directory, kind));
    const previous = this.manifest[kind][turnId];
    this.manifest[kind][turnId] = { hash, count: fragments.length };
    try { await this.save(); }
    catch (error) {
      if (previous) this.manifest[kind][turnId] = previous;
      else delete this.manifest[kind][turnId];
      throw error;
    }
  }

  async query(kind: Kind, input: string | Float32Array): Promise<RecallFragment[]> {
    const docs = await this.collections[kind].query({
      fieldName: kind === "keyword" ? "text" : "embedding", topk: 100, outputFields: ["payload"],
      ...(typeof input === "string" ? {
        fts: { matchString: input },
        // Require the supplied keywords together. OR over sentence fragments
        // lets particles such as 的/吗 overwhelm the independent semantic rank.
        params: { indexType: this.zvec.ZVecIndexType.FTS, defaultOperator: "AND" },
      } : { vector: input }),
    });
    return docs.map((doc) => JSON.parse(doc.fields.payload) as RecallFragment);
  }

  private save(): Promise<void> { return atomicJson(path.join(this.directory, "manifest.json"), this.manifest); }

  close(): void {
    const failures: unknown[] = [];
    for (const collection of Object.values(this.collections)) {
      try { collection.closeSync(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Failed to close recall index");
  }
}
