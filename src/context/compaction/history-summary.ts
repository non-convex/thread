// Cross-turn cumulative project-state document.

import type { Context, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelClient } from "../../agent/model-client.js";
import { COMPACTION_HISTORY_RESERVE_TOKENS } from "./policy.js";
import { currentTimeAnchor, requestSummary } from "./summary-call.js";

const HISTORY_INSTRUCTION = [
  "Compact the earlier part of this conversation into a complete project-state document for a continuing coding agent.",
  "",
  "Do not continue the conversation, answer its questions, or call tools. Return only the document body. Do not return a plan, explanation, preamble, or tool request.",
  "",
  "If a previous memory and summary of earlier work is present, update that structured project state using the newer conversation. Re-evaluate it instead of copying it mechanically: keep still-useful facts, replace stale state, and remove completed details that no longer help.",
  "",
  "Return one concise Markdown project-state document under these headings: `## Long-term memory`, `## Current project state`, `## Recent user-agent conversation`, `## Lessons learned`, and `## Notes worth keeping`.",
  "",
  "Long-term memory contains at most 25 independently useful, current entries in the exact form `- [YYYY-MM-DD] (memory content)`. Preserve goals, user decisions, architectural constraints, failed approaches and their reasons, external facts, and discoveries that cannot safely be recovered from files. Remove superseded or obsolete entries and merge repetitions.",
  "",
  "Current project state states the active objective and phase, durable implemented results, validation evidence, remaining risks, unfinished work, and the exact next useful action. Distinguish completed work from proposals and successful checks from unrun or failed checks.",
  "",
  "Recent user-agent conversation contains at most the 10 newest material interactions, oldest first, in the exact form `- [YYYY-MM-DD HH] (interaction content)`. It is a compact decision history, not a transcript.",
  "",
  "Lessons learned contains at most 10 entries in the exact form `- [YYYY-MM-DD] (lesson content)`, recording failures and hard-won experience from this work that would change how a later attempt is made: what was tried, why it did not work, and what to do instead. Maintain it like long-term memory: drop lessons that no longer apply, merge overlapping ones, and re-evaluate rather than accumulate. Be strict — record only a lesson that would plausibly prevent a repeated mistake, and leave the section empty rather than filling it with routine outcomes, restatements of the project state, or generic advice.",
  "",
  "Notes worth keeping contains at most 10 entries in the exact form `- [YYYY-MM-DD HH] (note content)`, recording points worth remembering that are not about this project: the user's stated preferences, working style, tools, environment, constraints, or other durable context noticed during the conversation. Apply the same strictness: record only a point that would change how you respond later, never project work, speculation about the user, or sensitive personal details, and leave the section empty when nothing qualifies.",
  "",
  "Preserve material tool outcomes but never copy raw logs, file contents, hidden reasoning, or routine commands. Only durable results represented by the workspace may be recovered from files; do not omit other important state. Treat later user corrections and evidence as authoritative. Do not invent facts.",
].join("\n");

export function historySummaryInstruction(): string {
  return `${HISTORY_INSTRUCTION}\n\n${currentTimeAnchor()}`;
}

export function isHistorySummaryInstruction(text: string): boolean {
  return text.includes("Compact the earlier part of this conversation into a complete project-state document");
}

/**
 * Generate the cumulative project-state document. The previous document is part
 * of the sliced context, so the model updates it in place rather than restating it.
 */
export function generateHistorySummary(options: {
  model: ModelClient;
  context: Context;
  signal: AbortSignal;
  reasoning?: ThinkingLevel;
}): Promise<string> {
  return requestSummary({
    model: options.model,
    context: options.context,
    signal: options.signal,
    maxTokens: Math.min(COMPACTION_HISTORY_RESERVE_TOKENS, options.model.maxOutputTokens),
    label: "History summary",
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
  });
}
