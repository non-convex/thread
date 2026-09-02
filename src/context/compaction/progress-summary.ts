// In-turn progress summary: continuity for a turn whose earlier steps were cut.

import type { Context, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelClient } from "../../agent/model-client.js";
import { COMPACTION_PROGRESS_RESERVE_TOKENS } from "./policy.js";
import { requestSummary } from "./summary-call.js";

const PROGRESS_INSTRUCTION = [
  "Summarize what has been done so far on this one task so that a continuing coding agent can pick it up without repeating work.",
  "",
  "Do not continue the task, answer questions, or call tools. Return only the summary body, with no preamble.",
  "",
  "The original request is available to the reader and must not be restated. Cover what was attempted, what succeeded, what failed and why, and the current state of the work.",
  "",
  "Keep hard facts verbatim: file paths, identifiers, commands, error messages, and numeric results. Do not paraphrase them.",
  "",
  "The most recent complete steps are shown separately after this summary, so do not describe them in detail.",
].join("\n");

const ROLLING_NOTE = [
  "",
  "A previous progress summary for this same turn is provided below. Update it with the newer work instead of copying it: keep facts that still matter verbatim, merge repetition, and drop details that no longer affect the remaining work.",
  "",
  "--- previous progress summary ---",
].join("\n");

/**
 * Generate the checkpoint that bridges a copied turn request and the retained
 * steps. It rolls forward from its own previous output, never from raw history:
 * the region it covers only grows, so re-reading the original trajectory would
 * defeat the point of compacting it.
 */
export function generateProgressSummary(options: {
  model: ModelClient;
  context: Context;
  signal: AbortSignal;
  previousSummary?: string;
  reasoning?: ThinkingLevel;
}): Promise<string> {
  const instruction = options.previousSummary
    ? `${PROGRESS_INSTRUCTION}\n${ROLLING_NOTE}\n${options.previousSummary}`
    : PROGRESS_INSTRUCTION;
  return requestSummary({
    model: options.model,
    context: {
      ...options.context,
      messages: [
        ...options.context.messages,
        { role: "user", content: instruction, timestamp: Date.now() },
      ],
    },
    signal: options.signal,
    maxTokens: Math.min(COMPACTION_PROGRESS_RESERVE_TOKENS, options.model.maxOutputTokens),
    label: "Turn progress summary",
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
  });
}

export function isProgressSummaryInstruction(text: string): boolean {
  return text.includes("Summarize what has been done so far on this one task");
}
