import { spawn, type ChildProcess } from "node:child_process";
import { prepareModel } from "./model-assets.js";
import { embeddingWorkerArgs } from "./worker-path.js";
import type { TextSpan } from "./types.js";

/** The injection seam used by offline tests; there is only one production model. */
export interface EmbeddingEngine {
  initialize(signal: AbortSignal): Promise<void>;
  split(text: string, signal: AbortSignal): Promise<TextSpan[]>;
  embed(texts: string[], purpose: "query" | "passage", signal: AbortSignal): Promise<Float32Array[]>;
  close(): Promise<void>;
}

interface Job {
  id: number;
  message: Record<string, unknown>;
  priority: boolean;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
}

export class LocalEmbedding implements EmbeddingEngine {
  private worker: ChildProcess | undefined;
  private active: Job | undefined;
  private queue: Job[] = [];
  private nextId = 1;
  private failure: Error | undefined;
  private closed = false;
  private exited: Promise<unknown> | undefined;

  constructor(private readonly home?: string) {}

  async initialize(signal: AbortSignal): Promise<void> {
    const directory = await prepareModel(signal, this.home);
    signal.throwIfAborted();
    if (this.closed) throw new Error("Embedding worker is closed");
    this.worker = spawn(process.execPath, embeddingWorkerArgs(), {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced",
    });
    let stderr = "";
    this.worker.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-8_192); });
    this.exited = new Promise((resolve) => this.worker!.once("close", resolve));
    this.worker.on("message", (message: { id: number; value?: unknown; error?: string }) => {
      const job = this.active;
      if (!job || job.id !== message.id) return;
      this.active = undefined;
      job.cleanup();
      if (message.error) job.reject(new Error(message.error));
      else job.resolve(message.value);
      this.pump();
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (!this.closed) this.fail(new Error(`Embedding worker exited (${code}): ${stderr}`));
    });
    await this.request({ method: "initialize", directory }, false, signal);
  }

  split(text: string, signal: AbortSignal): Promise<TextSpan[]> {
    return this.request({ method: "split", text }, false, signal) as Promise<TextSpan[]>;
  }

  embed(texts: string[], purpose: "query" | "passage", signal: AbortSignal): Promise<Float32Array[]> {
    return this.request({ method: "embed", texts, purpose }, purpose === "query", signal) as Promise<Float32Array[]>;
  }

  private request(message: Record<string, unknown>, priority: boolean, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (this.closed || this.failure) return Promise.reject(this.failure ?? new Error("Embedding worker is closed"));
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: this.nextId++, message, priority, resolve, reject,
        cleanup: () => signal.removeEventListener("abort", abort),
      };
      const abort = () => {
        this.queue = this.queue.filter((item) => item !== job);
        job.cleanup();
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  private pump(): void {
    if (this.active || !this.worker || this.closed || this.failure) return;
    const priority = this.queue.findIndex((job) => job.priority);
    const job = this.queue.splice(priority < 0 ? 0 : priority, 1)[0];
    if (!job) return;
    this.active = job;
    this.worker.send({ id: job.id, ...job.message }, (error) => { if (error) this.fail(error); });
  }

  private fail(error: Error): void {
    this.failure = error;
    const jobs = [...this.queue, ...(this.active ? [this.active] : [])];
    this.queue = [];
    this.active = undefined;
    for (const job of jobs) { job.cleanup(); job.reject(error); }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // ONNX N-API finalization crashes Bun 1.3.14 worker threads. A hidden child
    // process isolates the native runtime and gives cancellation a safe boundary.
    if (this.worker && !this.failure) await this.request({ method: "close" }, true, AbortSignal.timeout(3_000)).catch(() => undefined);
    this.closed = true;
    this.fail(new Error("Embedding worker is closed"));
    this.worker?.kill();
    await this.exited;
    this.worker = undefined;
  }
}
