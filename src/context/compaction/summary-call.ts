// Shared summary call: validate the response and retry silently on a bad one.

import { contentText, type Context, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelClient } from "../../agent/model-client.js";
import { COMPACTION_SUMMARY_ATTEMPTS } from "./policy.js";

/**
 * Run one summary request until it yields usable prose.
 *
 * Provider-level transient failures are already retried inside `stream`. This
 * loop covers the other failure mode: a response that arrives but is unusable
 * (empty, or an attempted tool call). Retries are silent — no UI event — and
 * exhausting them throws, because a compaction that cannot summarize must not
 * silently drop the region it was about to remove.
 */
export async function requestSummary(options: {
  model: ModelClient;
  context: Context;
  signal: AbortSignal;
  maxTokens: number;
  label: string;
  reasoning?: ThinkingLevel;
}): Promise<string> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= COMPACTION_SUMMARY_ATTEMPTS; attempt++) {
    options.signal.throwIfAborted();
    try {
      const response = await options.model.stream(options.context, {
        signal: options.signal,
        maxTokens: options.maxTokens,
        ...(options.reasoning ? { reasoning: options.reasoning } : {}),
      });
      if (response.stopReason === "aborted") {
        throw new DOMException(response.errorMessage ?? `${options.label} aborted`, "AbortError");
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage ?? `${options.label} request failed`);
      }
      if (response.stopReason === "toolUse" || response.content.some((block) => block.type === "toolCall")) {
        throw new Error(`${options.label} attempted to call a tool`);
      }
      const generated = contentText(response.content, "").trim();
      if (!generated) throw new Error(`${options.label} produced an empty summary`);
      return generated;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new Error(
    `${options.label} failed after ${COMPACTION_SUMMARY_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`,
  );
}

export function currentTimeAnchor(): string {
  const now = new Date();
  const year = now.getFullYear().toString().padStart(4, "0");
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  const hour = now.getHours().toString().padStart(2, "0");
  return `The current local date and time is ${year}-${month}-${day} ${hour}. Keep an existing timestamp verbatim when that entry's content is unchanged; use this time for entries written or revised now.`;
}
