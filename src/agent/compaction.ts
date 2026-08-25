import { type Context, type Message, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { SessionEntry } from "../domain.js";
import type { SessionService } from "../session/service.js";
import { estimateContextTokens } from "../utils/estimate.js";
import { createId } from "../utils/id.js";
import type { ModelClient } from "./model-client.js";

const PROJECT_STATE_REQUIREMENTS = [
  "The output must serve two purposes at once: preserve only project knowledge that is useful for future work, and",
  "compress the conversation history that is leaving the raw retained tail. Return one concise Markdown document",
  "organized under the following three headings.",
  "Under `## Long-term memory`, record durable knowledge as an ordered list of independent entries. Use exactly this",
  "format for every entry: `- [YYYY-MM-DD] (memory content)`. The timestamp is the entry's last-modified date, not",
  "its original mention date: keep the existing date when an entry is carried forward unchanged, and use the latest",
  "source date in the input when an entry is created, corrected, or merged. Do not store project details that can be",
  "inferred from the code or workspace. Store durable meta-information instead: active goals and constraints, user",
  "preferences, architectural directions and their reasons, conventions, and facts the user mentioned or requested,",
  "or the agent discovered, that remain useful over the long term. Reorganize this section on every compaction rather",
  "than appending blindly: remove entries that are obsolete, superseded, or no longer useful, add newly useful",
  "entries, and merge related entries into one when that still preserves their meaning. Keep at most 25 entries; when",
  "there are more, retain only the 25 most useful and current entries.",
  "Under `## Current project state`, record the current goal and phase, implemented workspace changes and intended",
  "behavior, validation evidence, unresolved problems or uncertainty, and the exact next useful action. Describe the",
  "material current state, not a historical inventory; omit completed changes that no longer help future work.",
  "Under `## Recent user-agent conversation`, record the most recent interactions as an ordered list, oldest first.",
  "Use exactly this format for every entry: `- [YYYY-MM-DD HH] (interaction content)`, where the timestamp marks when",
  "the interaction happened. Each entry states what the user asked, corrected, rejected, or decided, and the material",
  "assistant response, action, or outcome. This section exists so that you still remember recent interaction after",
  "compaction, so overlap with the project state is acceptable. Evict this section purely by time: keep at most the 10",
  "most recent entries and drop the oldest beyond that, even when their content still looks valuable — anything with",
  "durable value belongs in long-term memory instead. Never let this section become a turn-by-turn transcript.",
  "Treat later evidence as authoritative over earlier state. When an older item is contradicted, obsolete, completed",
  "and no longer useful, or too temporary to matter, replace or remove it instead of preserving both versions.",
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

const INITIAL_STATE_INSTRUCTION = [
  "Compact this conversation into a project state document, replacing the earlier turns that are about to leave your",
  "context. Read the conversation above as the source; later corrections and decisions supersede earlier ones. Select",
  "long-term memory for future usefulness rather than trying to preserve every detail.",
  PROJECT_STATE_REQUIREMENTS,
].join(" ");

const UPDATE_STATE_INSTRUCTION = [
  "Compact this conversation into an updated project state document, replacing the earlier turns that are about to",
  "leave your context. The conversation above already contains a previous project state followed by newer",
  "interactions. Re-evaluate that previous long-term memory instead of copying it mechanically: carry forward only",
  "items that remain valid and likely to help future work, even when the newer interactions do not repeat them, and",
  "update, replace, or remove items made stale or irrelevant by later evidence or the passage of time. Apply later",
  "user corrections and decisions over superseded state, move completed or validated work to its current status, and",
  "retain genuinely unresolved disagreement or uncertainty. Rebuild the recent-conversation section from the newest",
  "interactions rather than accumulating the whole history. Return one complete updated project state, not a change",
  "list and not two summaries.",
  PROJECT_STATE_REQUIREMENTS,
].join(" ");

const PRIOR_STATE_PREFIX = "[Summary of earlier project-session context]";

// pi-ai's simple request path keeps the same fixed safety margin when it clamps
// output tokens. Using it here makes the compaction decision match the request
// that will actually be sent.
export const CONTEXT_SAFETY_TOKENS = 4_096;
export const POST_COMPACTION_CONTEXT_RATIO = 0.07;
/**
 * Compaction forks the live conversation, so its request carries the same
 * prefix it is about to compact. Triggering at a ratio instead of "the next
 * request no longer fits" keeps enough headroom for that fork to be sent.
 */
export const COMPACTION_TRIGGER_RATIO = 0.78;
/** Slack reserved for the summary wrapper when sizing the retained tail. */
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

  /**
   * Compaction forks the live context, so the fork request carries the same
   * prefix plus the instruction and its own output budget. Trigger on a ratio
   * of the window to leave room for that, rather than waiting until the next
   * ordinary request no longer fits.
   */
  shouldCompact(requestTokens: number, _outputTokens: number): boolean {
    return requestTokens > Math.floor(this.model.contextWindow * COMPACTION_TRIGGER_RATIO);
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
    forkContext?: Context,
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
      forkContext,
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
    forkContext?: Context,
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
      const generated = await this.summarize(partition.toSummarize, signal, forkContext);
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

  private async summarize(
    messages: Message[],
    signal: AbortSignal,
    forkContext?: Context,
  ): Promise<{ summary: string; modelCalls: number }> {
    if (!forkContext) throw new Error("Compaction requires the live context to fork");
    const previousState = this.priorProjectState(messages[0]);
    const instruction = this.withTokenLimit(
      previousState === undefined ? INITIAL_STATE_INSTRUCTION : UPDATE_STATE_INSTRUCTION,
      this.maxSummaryTokens,
    );
    /* Fork the live conversation instead of rebuilding a projected transcript:
     * the model reads what it actually experienced, and the request reuses the
     * cached prefix. The fork still has to fit beside its own output budget. */
    const forkTokens = estimateContextTokens({
      ...forkContext,
      messages: [...forkContext.messages, { role: "user", content: instruction, timestamp: Date.now() }],
    }).tokens;
    const ceiling = this.model.contextWindow - this.safetyTokens - this.maxSummaryTokens;
    if (forkTokens > ceiling) {
      throw new Error(
        `Context is too large to compact: the forked request needs about ${forkTokens.toLocaleString("en-US")} tokens but only ${Math.max(0, ceiling).toLocaleString("en-US")} are available. Use /clear or /rewind to reduce it.`,
      );
    }
    const summary = await this.model.forkComplete(forkContext, instruction, {
      signal,
      maxTokens: this.maxSummaryTokens,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    });
    if (!summary.trim()) throw new Error("Compaction model returned an empty summary");
    return { summary: summary.trim(), modelCalls: 1 };
  }

  private priorProjectState(message: Message | undefined): string | undefined {
    if (!message || !this.isPriorSummaryMessage(message) || typeof message.content !== "string") return undefined;
    return message.content.slice(PRIOR_STATE_PREFIX.length).trim();
  }

  private withTokenLimit(prompt: string, maxTokens: number): string {
    return `${prompt}\n\nYour response must not exceed ${maxTokens.toLocaleString("en-US")} tokens. Use less when the required continuation context is already complete; never add filler to reach the limit.`;
  }
}
