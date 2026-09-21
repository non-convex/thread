import { open } from "node:fs/promises";
import type { ThreadRuntime } from "../core/runtime/thread-runtime.js";
import type { RuntimeEvent } from "../core/runtime/events.js";

const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;

function diagnosticRecord(event: RuntimeEvent): unknown | undefined {
  if (event.type === "model_cache_diagnostic") return event;
  if (event.type !== "model_attempt_finished" && event.type !== "model_call_finished") return undefined;
  // Prefer actual attempts; the logical call repeats its final attempt's usage.
  if (event.type === "model_call_finished" && event.attemptsObserved > 0) return undefined;
  return {
    type: event.type, timestamp: event.timestamp, callId: event.callId,
    providerId: event.providerId, modelId: event.modelId, purpose: event.purpose,
    executionId: event.executionId, agentId: event.agentId, sessionId: event.sessionId, turnId: event.turnId,
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.type === "model_attempt_finished" ? { attempt: event.attempt } : {}),
    outcome: event.outcome, durationMs: event.durationMs,
    ...(event.firstOutputAt !== undefined ? { firstOutputAt: event.firstOutputAt } : {}),
    ...(event.usage ? { usage: {
      input: event.usage.input, output: event.usage.output, cacheRead: event.usage.cacheRead,
      cacheWrite: event.usage.cacheWrite, totalTokens: event.usage.totalTokens,
    } } : {}),
  };
}

/** Explicit CLI export of content-free diagnostics; the CLI owns and drains this file. */
export async function openCacheDiagnostics(runtime: ThreadRuntime, outputPath: string): Promise<() => Promise<void>> {
  const file = await open(outputPath, "a", 0o600);
  let acceptedBytes: number;
  try {
    acceptedBytes = (await file.stat()).size;
    if (acceptedBytes >= MAX_LOG_BYTES) throw new Error("Cache diagnostics log reached 16 MiB; choose a new output file.");
  } catch (error) {
    await file.close();
    throw error;
  }
  let pending = Promise.resolve();
  let pendingBytes = 0;
  let failure: unknown;
  let unsubscribe = () => {};
  const stop = (error: unknown) => {
    failure ??= error;
    unsubscribe();
  };
  try {
    unsubscribe = runtime.subscribe((event) => {
      if (failure !== undefined) return;
      const record = diagnosticRecord(event);
      if (record === undefined) return;
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line);
      if (acceptedBytes + bytes > MAX_LOG_BYTES || pendingBytes + bytes > MAX_PENDING_BYTES) {
        stop(new Error("Cache diagnostics logging stopped at its file or pending-write limit."));
        return;
      }
      acceptedBytes += bytes;
      pendingBytes += bytes;
      pending = pending.then(() => file.appendFile(line)).catch(stop).finally(() => { pendingBytes -= bytes; });
    }, { promptCacheDiagnostics: true });
  } catch (error) {
    await file.close();
    throw error;
  }
  return async () => {
    unsubscribe();
    await pending;
    await file.close();
    if (failure !== undefined) throw failure;
  };
}
