import { isDeepStrictEqual } from "node:util";
import type { Message, ToolCall } from "@earendil-works/pi-ai";
import { safeUiEvent, type UiEventSink } from "../ui/events.js";
import type { ExecutionJournal } from "./execution-journal.js";
import { ToolCallExecutor, type PreparedToolCall } from "./tool-call-executor.js";
import { ToolScheduler } from "./tool-scheduler.js";

export interface IndexedToolCall {
  contentIndex: number;
  call: ToolCall;
}

/**
 * Coordinates every tool call emitted by one assistant message.
 *
 * Stream callbacks enter through observe(). Preflight is serialized to preserve
 * extension and durable-log order; eligible read effects are then launched
 * immediately. reconcile() binds the streamed facts to the final assistant
 * message. Result messages are returned in final assistant source order even
 * though completion events are emitted as individual tools finish.
 */
export class ToolExecutionBatch {
  private scheduler: ToolScheduler<Message>;
  private readonly prepared = new Map<string, PreparedToolCall>();
  private prepareTail: Promise<void> = Promise.resolve();
  private finalized: readonly PreparedToolCall[] | undefined;
  private lastStreamContentIndex = -1;

  constructor(
    private readonly input: {
      journal: ExecutionJournal;
      assistantEntryId: string;
      signal: AbortSignal;
      runner: ToolCallExecutor;
      ui?: UiEventSink;
    },
  ) {
    this.scheduler = new ToolScheduler<Message>(input.signal);
  }

  observe(call: ToolCall, contentIndex: number): Promise<void> {
    const stableCall = structuredClone(call);
    if (!this.prepared.has(stableCall.id)) {
      safeUiEvent(this.input.ui, {
        type: "tool_started",
        id: stableCall.id,
        name: stableCall.name,
        args: (stableCall.arguments ?? {}) as Record<string, unknown>,
        phase: "queued",
      });
    }
    const operation = this.prepareTail.then(async () => {
      await this.input.journal.ready;
      this.input.signal.throwIfAborted();
      const existing = this.prepared.get(stableCall.id);
      if (existing) {
        this.assertSameCall(existing.call, stableCall);
        return;
      }
      if (contentIndex < this.lastStreamContentIndex) {
        throw new Error(`Tool calls completed out of source order: content index ${contentIndex}`);
      }
      this.lastStreamContentIndex = contentIndex;
      const prepared = await this.input.runner.prepare({
        journal: this.input.journal,
        assistantEntryId: this.input.assistantEntryId,
        contentIndex,
        toolIndex: this.prepared.size,
        call: stableCall,
        signal: this.input.signal,
      });
      this.prepared.set(stableCall.id, prepared);
      this.scheduler.schedule({
        id: stableCall.id,
        mode: prepared.policy.mode,
        eager: prepared.policy.effect === "read",
        resources: prepared.resources,
        run: (signal) => this.input.runner.execute(prepared, signal, this.input.ui),
      });
    });
    this.prepareTail = operation.then(() => undefined);
    return operation;
  }

  async reconcile(finalCalls: readonly IndexedToolCall[]): Promise<void> {
    await this.prepareTail;
    const finalIds = new Set<string>();
    for (const item of finalCalls) {
      if (finalIds.has(item.call.id)) throw new Error(`Duplicate tool call id in assistant message: ${item.call.id}`);
      finalIds.add(item.call.id);
      const existing = this.prepared.get(item.call.id);
      if (existing) {
        this.assertSameCall(existing.call, item.call);
        if (existing.contentIndex !== item.contentIndex) {
          throw new Error(`Tool call moved within the assistant message: ${item.call.id}`);
        }
      } else {
        await this.observe(item.call, item.contentIndex);
      }
    }
    await this.prepareTail;
    for (const id of this.prepared.keys()) {
      if (!finalIds.has(id)) throw new Error(`Streamed tool call is absent from the final assistant message: ${id}`);
    }
    this.finalized = finalCalls.map((item) => this.prepared.get(item.call.id)!);
  }

  /** Release write/process/interactive calls after the complete assistant message is durable. */
  releaseResponse(): void {
    if (!this.finalized) throw new Error("Tool batch must be reconciled before execution is released");
    this.scheduler.releaseResponse();
  }

  async orderedResults(): Promise<Message[]> {
    if (!this.finalized) throw new Error("Tool batch has not been reconciled");
    const results: Message[] = [];
    for (const prepared of this.finalized) {
      const result = this.scheduler.result(prepared.call.id);
      if (!result) throw new Error(`Tool call was not scheduled: ${prepared.call.id}`);
      // Deliberately await in source order. The underlying tasks remain concurrent.
      results.push(await result);
    }
    return results;
  }

  async restartForModelRetry(reason: unknown, nextAssistantEntryId: string): Promise<void> {
    await this.prepareTail;
    await this.scheduler.cancel(reason);
    this.input.assistantEntryId = nextAssistantEntryId;
    this.scheduler = new ToolScheduler<Message>(this.input.signal);
    this.prepared.clear();
    this.finalized = undefined;
    this.lastStreamContentIndex = -1;
    this.prepareTail = Promise.resolve();
  }

  async cancel(reason?: unknown): Promise<void> {
    await this.scheduler.cancel(reason);
  }

  private assertSameCall(streamed: ToolCall, final: ToolCall): void {
    if (streamed.name !== final.name || !isDeepStrictEqual(streamed.arguments, final.arguments)) {
      throw new Error(`Tool call changed after it was streamed: ${final.id}`);
    }
  }
}
