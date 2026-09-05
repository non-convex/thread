import path from "node:path";
import type { SessionTreeService } from "../session-tree/service.js";
import type { Turn } from "../session-tree/model.js";
import { cooperativeYield } from "../utils/async.js";
import { documentsHash, extractDocuments, fragment, keywordFragments } from "./documents.js";
import { LocalEmbedding, type EmbeddingEngine } from "./embedding.js";
import { pathClassifier, readPath, readTurn } from "./reader.js";
import { ZvecRecallIndex } from "./zvec-index.js";
import type { EmbeddedFragment, ReadOptions, RecallDocument, RecallFragment, RecallSearchHit, RecallSearchResult, RetrievalSource } from "./types.js";

export interface SessionRecallOptions { semantic?: boolean; embedding?: EmbeddingEngine }
interface TurnDocuments { documents: RecallDocument[]; hash: string; semanticHash: string }
interface Candidate { hit: RecallSearchHit; score: number; literal: boolean; snippetScore: number }

export class SessionRecallService {
  private readonly lifetime = new AbortController();
  private readonly documents = new Map<string, TurnDocuments>();
  private readonly embedding: EmbeddingEngine;
  private readonly semanticEnabled: boolean;
  private index: ZvecRecallIndex | undefined;
  private indexFailure: string | undefined;
  private embeddingFailure: string | undefined;
  private embeddingReady = false;
  private preparation: Promise<void> | undefined;
  private activated = false;
  private backgroundRequested = false;
  private background: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private closing: Promise<void> | undefined;

  constructor(private readonly tree: SessionTreeService, options: SessionRecallOptions = {}) {
    this.semanticEnabled = options.semantic ?? true;
    this.embedding = options.embedding ?? new LocalEmbedding();
  }

  private endedTurns(): Turn[] { return [...this.tree.projection.turns.values()].filter((turn) => turn.status !== "running"); }

  private turnDocuments(turn: Turn): TurnDocuments {
    let cached = this.documents.get(turn.id);
    if (!cached) {
      const documents = extractDocuments(this.tree.projection.entriesByTurn.get(turn.id) ?? []);
      cached = { documents, hash: documentsHash(documents), semanticHash: documentsHash(documents.filter((doc) => doc.semantic)) };
      this.documents.set(turn.id, cached);
    }
    return cached;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async syncKeywords(turns: readonly Turn[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.indexFailure) throw new Error(this.indexFailure);
    if (!this.index) {
      const project = this.tree.repository.project;
      this.index = await ZvecRecallIndex.open(path.join(project.statePath, "session-search"), project.id, this.tree.tree.id);
    }
    for (const turn of turns) {
      signal.throwIfAborted();
      const { documents, hash } = this.turnDocuments(turn);
      if (this.index.has("keyword", turn.id, hash)) continue;
      await this.index.replaceTurn("keyword", turn.id, hash, documents.flatMap(keywordFragments), signal);
    }
  }

  /** Called after a durable turn ends; inactive recall never starts model downloads. */
  turnFinished(): void {
    if (!this.activated || this.lifetime.signal.aborted || this.indexFailure) return;
    this.backgroundRequested = true;
    if (this.background) return;
    this.background = this.runBackground().finally(() => {
      this.background = undefined;
      if (this.backgroundRequested && !this.indexFailure && !this.lifetime.signal.aborted) this.turnFinished();
    });
  }

  private async runBackground(): Promise<void> {
    const signal = this.lifetime.signal;
    try {
      if (this.semanticEnabled && !this.preparation) {
        this.preparation = this.embedding.initialize(signal).then(() => {
          if (signal.aborted) return;
          this.embeddingReady = true;
          this.turnFinished();
        }).catch((error) => { if (!signal.aborted) this.embeddingFailure = message(error); });
      }
      while (this.backgroundRequested) {
        signal.throwIfAborted();
        this.backgroundRequested = false;
        const turns = this.endedTurns();
        try { await this.serialized(() => this.syncKeywords(turns, signal)); }
        catch (error) { signal.throwIfAborted(); this.indexFailure = message(error); return; }
        if (!this.embeddingReady || this.embeddingFailure) continue;
        for (const turn of turns) {
          signal.throwIfAborted();
          const { documents, semanticHash } = this.turnDocuments(turn);
          if (this.index!.has("semantic", turn.id, semanticHash)) continue;
          const fragments: EmbeddedFragment[] = [];
          try {
            for (const document of documents.filter((item) => item.semantic)) {
              const spans = await this.embedding.split(document.text, signal);
              for (let offset = 0; offset < spans.length; offset += 4) {
                const batch = spans.slice(offset, offset + 4);
                const vectors = await this.embedding.embed(batch.map((span) => span.text), "passage", signal);
                if (vectors.length !== batch.length) throw new Error("Embedding returned an incomplete batch");
                fragments.push(...batch.map((span, index) => ({ ...fragment(document, span), vector: vectors[index]! })));
              }
            }
          } catch (error) { signal.throwIfAborted(); this.embeddingFailure = message(error); return; }
          try { await this.serialized(() => this.index!.replaceTurn("semantic", turn.id, semanticHash, fragments, signal)); }
          catch (error) { signal.throwIfAborted(); this.indexFailure = message(error); return; }
        }
      }
    } catch (error) {
      if (!signal.aborted) this.embeddingFailure = message(error);
    }
  }

  /** Explicit barrier for offline integrations and validation; normal search never waits for model preparation. */
  async whenIdle(): Promise<void> {
    await this.preparation;
    while (this.background) await this.background;
  }

  async search(queries: readonly string[], limit = 8, callerSignal?: AbortSignal): Promise<RecallSearchResult> {
    const signal = callerSignal ? AbortSignal.any([callerSignal, this.lifetime.signal]) : this.lifetime.signal;
    signal.throwIfAborted();
    const terms = [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
    if (!terms.length) throw new Error("At least one non-empty search query is required");
    if (!Number.isFinite(limit)) throw new Error("Search limit must be finite");
    const turns = this.endedTurns();
    const byId = new Map(turns.map((turn) => [turn.id, turn]));
    const classify = pathClassifier(this.tree);
    this.activated = true;
    try { await this.serialized(() => this.syncKeywords(turns, signal)); }
    catch (error) { signal.throwIfAborted(); this.indexFailure = message(error); }
    this.turnFinished();
    const candidates = new Map<string, Candidate>();
    let queryEmbeddingFailure: string | undefined;
    const add = (doc: RecallDocument, query: string, source: RetrievalSource, score: number, snippetText = doc.text) => {
      const turn = byId.get(doc.turnId);
      if (!turn) return;
      let candidate = candidates.get(turn.id);
      if (!candidate) {
        candidate = { score: 0, literal: false, snippetScore: -1, hit: {
          sessionId: turn.sessionId, turnId: turn.id, entryId: doc.entryId, kind: doc.kind, status: turn.status,
          startedAt: turn.startedAt, pathStatus: classify(turn), queries: [], sources: [], snippet: "",
        } };
        candidates.set(turn.id, candidate);
      }
      candidate.score += score;
      candidate.literal ||= source === "literal";
      if (!candidate.hit.queries.includes(query)) candidate.hit.queries.push(query);
      if (!candidate.hit.sources.includes(source)) candidate.hit.sources.push(source);
      const snippetScore = source === "literal" ? 1 : score;
      if (snippetScore > candidate.snippetScore) {
        candidate.snippetScore = snippetScore;
        candidate.hit.entryId = doc.entryId;
        candidate.hit.kind = doc.kind;
        const location = snippetText.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
        candidate.hit.snippet = snippetText.slice(Math.max(0, location - 100), Math.max(0, location - 100) + 320).replace(/\s+/g, " ").trim();
      }
    };
    const maybeYield = cooperativeYield();
    for (const query of terms) {
      for (const turn of turns) {
        const found = this.turnDocuments(turn).documents.find((doc) => doc.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
        if (found) add(found, query, "literal", 0);
        await maybeYield(signal);
      }
      if (this.indexFailure) continue;
      const merge = (docs: RecallFragment[], source: RetrievalSource) => {
        const seen = new Set<string>();
        for (const doc of docs) {
          if (!byId.has(doc.turnId) || seen.has(doc.turnId)) continue;
          seen.add(doc.turnId);
          add(doc, query, source, 1 / (60 + seen.size));
        }
      };
      try { merge(await this.serialized(() => this.index!.query("keyword", query)), "keyword"); }
      catch (error) { signal.throwIfAborted(); this.indexFailure = message(error); continue; }
      if (this.embeddingReady && !this.embeddingFailure) {
        let vector: Float32Array;
        try { [vector] = await this.embedding.embed([query], "query", signal) as [Float32Array]; }
        catch (error) { signal.throwIfAborted(); queryEmbeddingFailure = message(error); continue; }
        try { merge(await this.serialized(() => this.index!.query("semantic", vector)), "semantic"); }
        catch (error) { signal.throwIfAborted(); this.indexFailure = message(error); }
      }
    }
    signal.throwIfAborted();
    const keywordTurns = this.indexFailure ? 0 : turns.filter((turn) => this.index?.has("keyword", turn.id, this.turnDocuments(turn).hash)).length;
    const semanticTurns = this.indexFailure ? 0 : turns.filter((turn) => this.index?.has("semantic", turn.id, this.turnDocuments(turn).semanticHash)).length;
    return {
      coverage: { totalTurns: turns.length, keywordTurns, semanticTurns },
      semantic: !this.semanticEnabled ? "disabled" : this.indexFailure || this.embeddingFailure || queryEmbeddingFailure ? "unavailable" : !this.embeddingReady ? "preparing"
        : semanticTurns < turns.length ? "indexing" : "ready",
      diagnostics: [this.indexFailure && `zvec unavailable; using literal search: ${this.indexFailure}`,
        this.embeddingFailure && `Semantic recall unavailable; using keyword search: ${this.embeddingFailure}`,
        queryEmbeddingFailure && `A semantic query failed; keyword results are included: ${queryEmbeddingFailure}`].filter((item): item is string => Boolean(item)),
      hits: [...candidates.values()].sort((a, b) => Number(b.literal) - Number(a.literal) || b.score - a.score || b.hit.startedAt - a.hit.startedAt)
        .slice(0, Math.max(1, Math.min(50, Math.floor(limit)))).map((item) => item.hit),
    };
  }

  read(turnId: string, options: ReadOptions = {}) { return readTurn(this.tree, turnId, options); }
  readPath(turnId: string, options: ReadOptions = {}) { return readPath(this.tree, turnId, options); }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.lifetime.abort(new Error("Session recall is closed"));
      await this.preparation;
      await this.background;
      await this.queue;
      await this.embedding.close().catch(() => undefined);
      try { this.index?.close(); } catch { /* The index can be reconstructed from the durable tree. */ }
    })();
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
