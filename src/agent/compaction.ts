import { type Message, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { SessionEntry } from "../domain.js";
import type { SessionService } from "../session/service.js";
import { estimateContextTokens } from "../utils/estimate.js";
import { createId } from "../utils/id.js";
import { semanticMessageTranscript } from "./message-projection.js";
import type { ModelClient } from "./model-client.js";

const PROJECT_STATE_REQUIREMENTS = [
  "The output must serve two purposes at once: preserve only project knowledge that is useful for future work, and",
  "compress the conversation history that is leaving the raw retained tail. Return one concise Markdown document",
  "organized under the following headings when relevant.",
  "Under `## Long-term project memory`, selectively retain durable goals, active requirements and constraints, user",
  "preferences that affect future work, architectural decisions and their reasons, conventions, and other facts",
  "likely to matter again. A fact does not belong here merely because it appeared in the conversation. Do not retain",
  "routine execution details, one-off chatter, superseded instructions, or completed details with no future value.",
  "Under `## Current project state`, record the current goal and phase, implemented workspace changes and intended",
  "behavior, validation evidence, unresolved problems or uncertainty, and the exact next useful action. Describe the",
  "material current state, not a historical inventory; omit completed changes that no longer help future work.",
  "Always include `## Recent compressed conversation`: concisely summarize the most recent interactions absorbed by",
  "this compaction, including what the user discussed, asked, corrected, rejected, or decided and the material",
  "assistant response, action, or outcome. This section may contain useful conversational context that is not durable",
  "project memory, but it must not become a turn-by-turn transcript or repeat the retained raw tail.",
  "Treat later evidence as authoritative over earlier state. When an older item is contradicted, obsolete, completed",
  "and no longer useful, or too temporary to matter, replace or remove it instead of preserving both versions.",
  "Use dates selectively. For time-sensitive requirements, decisions, deadlines, temporary conditions, version",
  "assumptions, and changed or superseded facts, record the source-based absolute date in YYYY-MM-DD form when it",
  "helps future freshness decisions. Do not attach dates to timeless facts merely for completeness, and do not invent",
  "a date that the input does not support.",
  "Preserve material outcomes and evidence from tool calls, not raw tool output.",
  "For reads and searches, record relevant paths, symbols, and findings without copying file contents.",
  "For edits, record changed files and intended behavior. Do not inventory commands.",
  "Retain a command only when its exact form is needed to reproduce an important validation or unresolved failure;",
  "otherwise retain only the material outcome.",
  "Consolidate repeated tests or command attempts into one conclusion.",
  "Omit routine navigation, inspection commands, successful commands with no future relevance, and repetitive,",
  "superseded, or irrelevant output. Do not invent facts.",
  "Clearly distinguish implemented work from proposals, successful validation from failed or unrun checks, and",
  "evidence from inference. Use concise Markdown with useful project-state headings; omit empty headings.",
].join(" ");

const INITIAL_STATE_SYSTEM_PROMPT = [
  "Create the initial compacted project state from the supplied chronological session interactions.",
  "Within those interactions, later corrections and decisions supersede earlier ones. Select long-term memory for",
  "future usefulness rather than trying to preserve every detail.",
  PROJECT_STATE_REQUIREMENTS,
].join(" ");

const UPDATE_STATE_SYSTEM_PROMPT = [
  "Update an existing compacted project state using later chronological session interactions.",
  "The input contains PREVIOUS PROJECT STATE and NEW INTERACTIONS TO ABSORB. Re-evaluate the previous long-term",
  "memory instead of copying it mechanically. Carry forward only items that remain valid and likely to help future",
  "work, even when the new interactions do not repeat them; update, replace, or remove items made stale or irrelevant",
  "by later evidence or the passage of time. Apply later user corrections and decisions over superseded state, move",
  "completed or validated work to its current status, and retain genuinely unresolved disagreement or uncertainty.",
  "Replace the old Recent compressed conversation section with a fresh digest of the newest interactions being",
  "absorbed; do not accumulate the entire conversation history in that section. Return one complete updated project",
  "state, not a change list and not two summaries.",
  PROJECT_STATE_REQUIREMENTS,
].join(" ");

const CHUNK_SYSTEM_PROMPT = [
  "Summarize one chronological fragment of a coding-agent session.",
  "Preserve concrete user requirements, corrections, decisions, code changes, validation evidence, unresolved",
  "problems, source uncertainty, and what the user discussed or asked. Messages carry YYYY-MM-DD source dates; retain",
  "an absolute date for time-sensitive or superseding information when it is needed later to judge freshness.",
  "Preserve material tool-call findings and essential diagnostics, but do not inventory commands or copy long file",
  "contents, search results, or logs.",
  "Keep an exact command only when required to reproduce an important validation or unresolved failure.",
  "Consolidate repeated tests and attempts into conclusions; omit routine navigation, inspection commands, and",
  "successful commands with no future relevance.",
  "This fragment will later be merged with summaries of other fragments. Do not invent facts.",
  "Return concise free text.",
].join(" ");

const REDUCTION_SYSTEM_PROMPT = [
  "Merge chronological partial summaries of new coding-agent interactions into fewer chronological partial",
  "summaries. These will later be applied to a separate previous project state, so preserve corrections, decisions,",
  "changes, validation, unresolved problems, source uncertainty, what the user discussed or asked, relevant absolute",
  "dates, and ordering needed to update that state. Preserve which later facts correct, replace, or invalidate earlier",
  "ones, and keep the most recent conversational context identifiable for the final recent-conversation digest.",
  "Remove repetition while preserving the project goal, explicit user requirements, decisions, files changed and",
  "their intended behavior, material tool-call findings, validation results, unresolved problems, and the exact next",
  "useful action. Do not produce a command history: retain exact commands only when needed to reproduce important",
  "validation or unresolved failures, and consolidate repeated tests or attempts into conclusions.",
  "Keep conclusions and essential evidence, not raw file contents or logs. Do not invent facts.",
  "Return concise free text.",
].join(" ");

const PRIOR_STATE_PREFIX = "[Summary of earlier project-session context]";

// pi-ai's simple request path keeps the same fixed safety margin when it clamps
// output tokens. Using it here makes the compaction decision match the request
// that will actually be sent.
export const CONTEXT_SAFETY_TOKENS = 4_096;
export const POST_COMPACTION_CONTEXT_RATIO = 0.07;
const INTERMEDIATE_SUMMARY_TOKENS = 1_536;
const PROMPT_WRAPPER_TOKENS = 128;

export interface CompactionOptions {
  minRetainTurns?: number;
  maxSummaryTokens?: number;
  safetyTokens?: number;
  reasoning?: ThinkingLevel;
}

export interface CompactionObserver {
  started(reason: "manual" | "threshold" | "overflow"): void;
  finished(ok: boolean): void;
}

export interface CompactionRun {
  entry: Extract<SessionEntry, { type: "compaction" }>;
  summarizedMessages: number;
  retainedMessages: number;
  modelCalls: number;
}

export interface CompactionExecution {
  runId?: string;
  resultEntryId?: string;
}

export interface CompactionRequestBudget {
  requestTokens: number;
  outputTokens: number;
  overheadTokens: number;
}

export class ContextCompactor {
  private readonly minRetainTurns: number;
  private readonly maxSummaryTokens: number;
  private readonly safetyTokens: number;
  private readonly reasoning: ThinkingLevel | undefined;

  constructor(
    private readonly session: SessionService,
    private readonly model: ModelClient,
    options: CompactionOptions = {},
  ) {
    this.minRetainTurns = options.minRetainTurns ?? 2;
    this.maxSummaryTokens = Math.min(options.maxSummaryTokens ?? 4_000, model.maxOutputTokens);
    this.safetyTokens = options.safetyTokens ?? CONTEXT_SAFETY_TOKENS;
    this.reasoning = options.reasoning;
    if (this.minRetainTurns < 1) throw new Error("minRetainTurns must be at least 1");
    if (this.maxSummaryTokens < 1) throw new Error("maxSummaryTokens must be at least 1");
  }

  shouldCompact(requestTokens: number, outputTokens: number): boolean {
    return requestTokens + outputTokens + this.safetyTokens > this.model.contextWindow;
  }

  retainedTailBudget(overheadTokens: number): number {
    const targetContextTokens = Math.floor(this.model.contextWindow * POST_COMPACTION_CONTEXT_RATIO);
    return Math.max(
      0,
      targetContextTokens - overheadTokens - this.maxSummaryTokens - PROMPT_WRAPPER_TOKENS,
    );
  }

  canCompact(messages: readonly Message[], retainedTailBudgetTokens: number): boolean {
    const partition = this.partition(messages, retainedTailBudgetTokens);
    return partition.toSummarize.length > 0 && !this.isPriorSummaryOnly(partition.toSummarize);
  }

  async compactIfNeeded(
    lane: string,
    messages: Message[],
    budget: CompactionRequestBudget,
    signal: AbortSignal,
    execution: CompactionExecution = {},
    observer?: CompactionObserver,
  ): Promise<CompactionRun | undefined> {
    if (!this.shouldCompact(budget.requestTokens, budget.outputTokens)) return undefined;
    return this.compact(
      lane,
      messages,
      budget.requestTokens,
      this.retainedTailBudget(budget.overheadTokens),
      signal,
      execution,
      "threshold",
      observer,
    );
  }

  async compact(
    lane: string,
    messages: Message[],
    tokensBefore: number,
    retainedTailBudgetTokens: number,
    signal: AbortSignal,
    execution: CompactionExecution = {},
    reason: "manual" | "threshold" | "overflow" = "manual",
    observer?: CompactionObserver,
  ): Promise<CompactionRun | undefined> {
    const partition = this.partition(messages, retainedTailBudgetTokens);
    if (partition.toSummarize.length === 0 || this.isPriorSummaryOnly(partition.toSummarize)) return undefined;
    observer?.started(reason);
    const resultEntryId = execution.resultEntryId ?? createId("entry");
    try {
      if (execution.runId) {
        await this.session.appendRecord(
          {
            id: createId("record"),
            type: "step_attempt",
            lane,
            runId: execution.runId,
            step: "compaction",
            attempt: 1,
            resultEntryId,
            compactionReason: reason,
          },
          true,
        );
      }
      const generated = await this.summarize(partition.toSummarize, signal);
      const entry = await this.session.appendEntry(
        lane,
        {
          id: resultEntryId,
          sessionId: this.session.store.sessionId,
          type: "compaction",
          summary: generated.summary,
          retainedTail: structuredClone(partition.retainedTail),
          tokensBefore,
        },
        true,
      );
      observer?.finished(true);
      return {
        entry: entry as Extract<SessionEntry, { type: "compaction" }>,
        summarizedMessages: partition.toSummarize.length,
        retainedMessages: partition.retainedTail.length,
        modelCalls: generated.modelCalls,
      };
    } catch (error) {
      observer?.finished(false);
      throw error;
    }
  }

  private partition(
    messages: readonly Message[],
    retainedTailBudgetTokens: number,
  ): { toSummarize: Message[]; retainedTail: Message[] } {
    const userStarts: number[] = [];
    for (let index = 0; index < messages.length; index++) {
      if (messages[index]!.role === "user" && !this.isPriorSummaryMessage(messages[index]!)) userStarts.push(index);
    }
    if (userStarts.length <= this.minRetainTurns) {
      return { toSummarize: [], retainedTail: structuredClone(messages) as Message[] };
    }

    let retainedTurns = this.minRetainTurns;
    // Always leave at least one older interaction for the summary; otherwise a
    // manual compaction could report success without reducing anything.
    for (let candidate = this.minRetainTurns + 1; candidate < userStarts.length; candidate++) {
      const candidateStart = userStarts[userStarts.length - candidate]!;
      const candidateTail = messages.slice(candidateStart);
      if (this.estimateTailTokens(candidateTail) > retainedTailBudgetTokens) break;
      retainedTurns = candidate;
    }
    const tailStart = userStarts[userStarts.length - retainedTurns]!;
    return {
      toSummarize: structuredClone(messages.slice(0, tailStart)) as Message[],
      retainedTail: structuredClone(messages.slice(tailStart)) as Message[],
    };
  }

  private isPriorSummaryOnly(messages: readonly Message[]): boolean {
    return messages.length === 1 && this.isPriorSummaryMessage(messages[0]!);
  }

  private isPriorSummaryMessage(message: Message): boolean {
    return (
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith(PRIOR_STATE_PREFIX)
    );
  }

  private estimateTailTokens(messages: readonly Message[]): number {
    // A newer empty prefix invalidates assistant usage metadata that described
    // the pre-compaction context, forcing pi-ai to estimate this tail by its
    // actual retained contents instead.
    const estimateMarker: Message = {
      role: "user",
      content: "",
      timestamp: Number.MAX_SAFE_INTEGER,
    };
    return estimateContextTokens([estimateMarker, ...messages]).tokens;
  }

  private async summarize(messages: Message[], signal: AbortSignal): Promise<{ summary: string; modelCalls: number }> {
    const previousState = this.priorProjectState(messages[0]);
    const newMessages = previousState === undefined ? messages : messages.slice(1);
    const transcript = semanticMessageTranscript(
      newMessages,
      "Session interaction message",
      "[No new session interactions.]",
    );
    const finalPrompt = this.withTokenLimit(
      previousState === undefined ? INITIAL_STATE_SYSTEM_PROMPT : UPDATE_STATE_SYSTEM_PROMPT,
      this.maxSummaryTokens,
    );
    const directLimit = this.maxPromptChars(finalPrompt, this.maxSummaryTokens);
    const directInput = this.projectStateInput(previousState, transcript);
    if (directInput.length <= directLimit) {
      const summary = await this.complete(finalPrompt, directInput, this.maxSummaryTokens, signal);
      return { summary, modelCalls: 1 };
    }

    const intermediateTokens = Math.min(INTERMEDIATE_SUMMARY_TOKENS, this.maxSummaryTokens);
    const chunkPrompt = this.withTokenLimit(CHUNK_SYSTEM_PROMPT, intermediateTokens);
    const chunkLimit = this.maxPromptChars(chunkPrompt, intermediateTokens);
    const chunks = this.splitText(transcript, chunkLimit);
    let modelCalls = 0;
    let partials: string[] = [];
    for (let index = 0; index < chunks.length; index++) {
      partials.push(
        await this.complete(
          chunkPrompt,
          `[Transcript fragment ${index + 1}/${chunks.length}]\n${chunks[index]!}`,
          intermediateTokens,
          signal,
        ),
      );
      modelCalls++;
    }

    const reductionPrompt = this.withTokenLimit(REDUCTION_SYSTEM_PROMPT, intermediateTokens);
    const finalLimit = this.maxPromptChars(finalPrompt, this.maxSummaryTokens);
    if (this.projectStateInput(previousState, "").length >= finalLimit) {
      throw new Error("Previous compacted project state leaves no room for new interaction summaries");
    }
    for (let pass = 0; pass < 12; pass++) {
      const combined = partials.map((summary, index) => `[Partial summary ${index + 1}]\n${summary}`).join("\n\n");
      const stateInput = this.projectStateInput(previousState, combined);
      if (stateInput.length <= finalLimit) {
        const summary = await this.complete(finalPrompt, stateInput, this.maxSummaryTokens, signal);
        return { summary, modelCalls: modelCalls + 1 };
      }
      const reductionLimit = this.maxPromptChars(reductionPrompt, intermediateTokens);
      const reductionChunks = this.splitText(combined, reductionLimit);
      const next: string[] = [];
      for (let index = 0; index < reductionChunks.length; index++) {
        next.push(
          await this.complete(
            reductionPrompt,
            `[Summary reduction ${index + 1}/${reductionChunks.length}]\n${reductionChunks[index]!}`,
            intermediateTokens,
            signal,
          ),
        );
        modelCalls++;
      }
      const previousLength = combined.length;
      const nextLength = next.reduce((sum, value) => sum + value.length, 0);
      if (nextLength >= previousLength) throw new Error("Chunked compaction did not reduce its intermediate summaries");
      partials = next;
    }
    throw new Error("Chunked compaction exceeded its reduction pass limit");
  }

  private priorProjectState(message: Message | undefined): string | undefined {
    if (!message || !this.isPriorSummaryMessage(message) || typeof message.content !== "string") return undefined;
    return message.content.slice(PRIOR_STATE_PREFIX.length).trim();
  }

  private projectStateInput(previousState: string | undefined, newEvidence: string): string {
    if (previousState === undefined) {
      return `[SESSION INTERACTIONS TO CONVERT INTO PROJECT STATE]\n${newEvidence}`;
    }
    return [
      `[PREVIOUS PROJECT STATE — CARRY FORWARD UNCHANGED ITEMS]\n${previousState}`,
      `[NEW INTERACTIONS TO ABSORB — LATER EVIDENCE OVERRIDES SUPERSEDED STATE]\n${newEvidence}`,
    ].join("\n\n");
  }

  private maxPromptChars(systemPrompt: string, outputTokens: number): number {
    const systemTokens = Math.ceil(systemPrompt.length / 4);
    const available =
      this.model.contextWindow - this.safetyTokens - outputTokens - systemTokens - PROMPT_WRAPPER_TOKENS;
    if (available < 256) {
      throw new Error(`Model context window ${this.model.contextWindow} is too small for compaction`);
    }
    return available * 4;
  }

  private withTokenLimit(prompt: string, maxTokens: number): string {
    return `${prompt}\n\nYour response must not exceed ${maxTokens.toLocaleString("en-US")} tokens. Use less when the required continuation context is already complete; never add filler to reach the limit.`;
  }

  private splitText(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxChars) {
      const window = remaining.slice(0, maxChars);
      const newline = window.lastIndexOf("\n");
      const cut = newline >= Math.floor(maxChars / 2) ? newline + 1 : maxChars;
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  private async complete(
    systemPrompt: string,
    prompt: string,
    maxTokens: number,
    signal: AbortSignal,
  ): Promise<string> {
    const result = await this.model.completeText(systemPrompt, prompt, {
      signal,
      maxTokens,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    });
    if (!result.trim()) throw new Error("Compaction model returned an empty summary");
    return result.trim();
  }
}
