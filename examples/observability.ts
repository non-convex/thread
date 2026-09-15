import type { ThreadRuntime } from "thread/runtime";

// Also loadable by the coding app: thread --extension ./examples/observability.ts
export default function observe(runtime: Pick<ThreadRuntime, "subscribe">): () => void {
  return runtime.subscribe((event) => {
    if (event.type !== "model_attempt_finished" && event.type !== "model_call_finished") return;
    if (event.type === "model_call_finished" && event.attemptsObserved > 0) return;
    console.error(JSON.stringify({
      type: "model_usage",
      sessionId: event.sessionId,
      turnId: event.turnId,
      executionId: event.executionId,
      agentId: event.agentId,
      taskId: event.taskId,
      revision: event.revision,
      callId: event.callId,
      attempt: event.type === "model_attempt_finished" ? event.attempt : undefined,
      model: `${event.providerId}/${event.modelId}`,
      purpose: event.purpose,
      outcome: event.outcome,
      timestamp: event.timestamp,
      durationMs: event.durationMs,
      usage: event.usage,
    }));
  });
}
