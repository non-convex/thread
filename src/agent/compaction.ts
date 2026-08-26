import { type Context, type Message, type ThinkingLevel } from "@earendil-works/pi-ai";
import type { SessionEntry } from "../domain.js";
import type { BuiltSessionContext, MessageOrigin, SessionService } from "../session/service.js";
import type { WorkspaceFileDiff } from "../workspace/sidecar-store.js";
import { estimateContextTokens } from "../utils/estimate.js";
import { createId } from "../utils/id.js";
import type { ModelClient } from "./model-client.js";

const PROJECT_STATE_REQUIREMENTS = [
  "Return one concise Markdown project-state document under these headings: `## Long-term memory`,",
  "`## Current project state`, and `## Recent user-agent conversation`.",
  "Long-term memory contains at most 25 independently useful, current entries in the exact form",
  "`- [YYYY-MM-DD] (memory content)`. Preserve goals, user decisions, architectural constraints, failed",
  "approaches and their reasons, external facts, and discoveries that cannot safely be recovered from files.",
  "Remove superseded or obsolete entries and merge repetitions.",
  "Current project state states the active objective and phase, durable implemented results, validation evidence,",
  "remaining risks, unfinished work, and the exact next useful action. Distinguish completed work from proposals",
  "and successful checks from unrun or failed checks.",
  "Recent user-agent conversation contains at most the 10 newest material interactions, oldest first, in the exact",
  "form `- [YYYY-MM-DD HH] (interaction content)`. It is a compact decision history, not a transcript.",
  "Preserve material tool outcomes but never copy raw logs, file contents, hidden reasoning, or routine commands.",
  "Only durable results represented by the workspace may be recovered from files; do not omit other important state.",
  "Treat later user corrections and evidence as authoritative. Do not invent facts.",
].join(" ");

const INITIAL_STATE_INSTRUCTION = [
  "Compact the earlier part of this conversation into a complete project state for a continuing coding agent.",
  PROJECT_STATE_REQUIREMENTS,
].join(" ");

const UPDATE_STATE_INSTRUCTION = [
  "Update the existing structured project state using the newer conversation. Re-evaluate it instead of copying it",
  "mechanically: keep still-useful facts, replace stale state, and remove completed details that no longer help.",
  PROJECT_STATE_REQUIREMENTS,
].join(" ");

const INCREMENTAL_INSTRUCTION = [
  "Summarize the selected user turn through the current conversation leaf as one concise Markdown continuation",
  "request. Preserve the selected goal, later user decisions and corrections, completed durable results, validation",
  "evidence, failed approaches and why they failed, unresolved issues, external facts, and the exact next useful action.",
  "Do not regenerate the earlier project history because it remains before this new message. Do not invent facts.",
].join(" ");

const READ_ONLY_FORK_RULE = [
  "This is a read-only summary branch. Do not call or request any tool, even though tool definitions are present.",
  "Return only the summary body. Do not return a plan, explanation, preamble, or tool request.",
].join(" ");

export const CONTEXT_SAFETY_TOKENS = 4_096;
export const POST_COMPACTION_CONTEXT_RATIO = 0.07;
export const COMPACTION_TRIGGER_RATIO = 0.78;
export const WORKSPACE_DIFF_MAX_FILES = 100;
export const WORKSPACE_DIFF_MAX_BYTES = 8 * 1024;
const PROMPT_WRAPPER_TOKENS = 128;

function currentTimeAnchor(now = new Date()): string {
  const year = now.getFullYear().toString().padStart(4, "0");
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  const hour = now.getHours().toString().padStart(2, "0");
  return `The current local date and time is ${year}-${month}-${day} ${hour}. Keep an existing memory timestamp verbatim when its content is unchanged; use this time for entries written or revised now.`;
}

export interface CompactionOptions {
  minRetainTurns?: number;
  maxSummaryTokens?: number;
  maxIncrementalSummaryTokens?: number;
  safetyTokens?: number;
  reasoning?: ThinkingLevel;
}

export interface CompactionObserver {
  started(reason: "manual" | "threshold" | "overflow"): void;
  finished(ok: boolean): void;
}

export interface CompactionRequestBudget {
  requestTokens: number;
  outputTokens: number;
  overheadTokens: number;
}

export interface RootSquashDraft {
  summaryKind: "project_state";
  summary: string;
  workspaceDiffStat: string;
  retainedTail: Array<{ sourceEntryId: string; message: Message }>;
  requestTokensBefore: number;
  summarizedMessages: number;
  retainedMessages: number;
  summarizedEntries: number;
  summarizedTurns: number;
  modelCalls: 1;
}

export interface IncrementalSquashDraft {
  summaryKind: "incremental";
  summary: string;
  workspaceDiffStat: string;
  retainedTail: [];
  requestTokensBefore: number;
  summarizedMessages: number;
  summarizedEntries: number;
  summarizedTurns: number;
  modelCalls: 1;
}

interface RootPartition {
  toSummarize: Message[];
  retainedTail: Array<{ sourceEntryId: string; message: Message }>;
  retainedStartUserOrdinal: number;
  summarizedEntries: number;
  summarizedTurns: number;
}

function jsonPath(path: string): string {
  return JSON.stringify(path);
}

function diffLine(file: WorkspaceFileDiff): string {
  const change = file.binary ? "binary" : `+${file.additions ?? 0} -${file.deletions ?? 0}`;
  const target = file.status === "renamed" && file.oldPath
    ? `${jsonPath(file.oldPath)} -> ${jsonPath(file.path)}`
    : jsonPath(file.path);
  return `${file.status.padEnd(8)} ${change.padEnd(18)} ${target}`;
}

/** Stable, prompt-safe, bounded machine facts for a checkpointed tree diff. */
export function formatWorkspaceDiffStat(files: readonly WorkspaceFileDiff[]): string {
  const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0);
  const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0);
  const binaryFiles = files.filter((file) => file.binary).length;
  const header = `total: ${files.length} file(s), +${additions} -${deletions}, ${binaryFiles} binary`;
  if (files.length === 0) return `${header}\n(no changed files)`;

  const selected: string[] = [];
  const candidateFiles = files.slice(0, WORKSPACE_DIFF_MAX_FILES);
  for (const file of candidateFiles) {
    const candidate = [...selected, diffLine(file)];
    const omitted = files.length - candidate.length;
    const footer = omitted > 0 ? `[truncated: ${omitted} file(s) omitted]` : "";
    const output = [header, ...candidate, footer].filter(Boolean).join("\n");
    if (Buffer.byteLength(output, "utf8") > WORKSPACE_DIFF_MAX_BYTES) break;
    selected.push(candidate.at(-1)!);
  }
  const omitted = files.length - selected.length;
  const footer = omitted > 0 ? `[truncated: ${omitted} file(s) omitted]` : "";
  return [header, ...selected, footer].filter(Boolean).join("\n");
}

export class ContextCompactor {
  private readonly minRetainTurns: number;
  private readonly maxSummaryTokens: number;
  private readonly maxIncrementalSummaryTokens: number;
  private readonly safetyTokens: number;
  private readonly reasoning: ThinkingLevel | undefined;

  constructor(
    private readonly session: SessionService,
    private readonly model: ModelClient,
    options: CompactionOptions = {},
  ) {
    this.minRetainTurns = options.minRetainTurns ?? 2;
    this.maxSummaryTokens = Math.min(options.maxSummaryTokens ?? 4_000, model.maxOutputTokens);
    this.maxIncrementalSummaryTokens = Math.min(options.maxIncrementalSummaryTokens ?? 2_000, model.maxOutputTokens);
    this.safetyTokens = options.safetyTokens ?? CONTEXT_SAFETY_TOKENS;
    this.reasoning = options.reasoning;
    if (this.minRetainTurns < 1) throw new Error("minRetainTurns must be at least 1");
  }

  shouldCompact(requestTokens: number, _outputTokens: number): boolean {
    return requestTokens > Math.floor(this.model.contextWindow * COMPACTION_TRIGGER_RATIO);
  }

  retainedTailBudget(overheadTokens: number, workspaceDiffTokens = 0): number {
    const target = Math.floor(this.model.contextWindow * POST_COMPACTION_CONTEXT_RATIO);
    return Math.max(0, target - overheadTokens - workspaceDiffTokens - this.maxSummaryTokens - PROMPT_WRAPPER_TOKENS);
  }

  canCompact(built: BuiltSessionContext, retainedTailBudgetTokens: number): boolean {
    return this.partitionRoot(built, retainedTailBudgetTokens) !== undefined;
  }

  async createProjectStateDraft(options: {
    built: BuiltSessionContext;
    requestTokensBefore: number;
    retainedTailBudgetTokens: number;
    workspaceDiffStat: string;
    signal: AbortSignal;
    forkContext: Context;
  }): Promise<RootSquashDraft | undefined> {
    const partition = this.partitionRoot(options.built, options.retainedTailBudgetTokens);
    if (!partition) return undefined;
    const boundary = [
      `The retained raw tail starts at user message #${this.forkUserOrdinal(
        options.built,
        options.forkContext,
        partition.retainedStartUserOrdinal,
      )} in the conversation prefix.`,
      "That user message and everything after it will be retained verbatim.",
      "Your summary replaces only content before that boundary and must not duplicate the retained tail in detail.",
    ].join(" ");
    const base = options.built.rootProjectState ? UPDATE_STATE_INSTRUCTION : INITIAL_STATE_INSTRUCTION;
    const instruction = this.withTokenLimit(
      `${base}\n\n${boundary}\n\n${currentTimeAnchor()}\n\n${READ_ONLY_FORK_RULE}`,
      this.maxSummaryTokens,
    );
    const summary = await this.summarize(options.forkContext, instruction, this.maxSummaryTokens, options.signal);
    return {
      summaryKind: "project_state",
      summary,
      workspaceDiffStat: options.workspaceDiffStat,
      retainedTail: partition.retainedTail,
      requestTokensBefore: options.requestTokensBefore,
      summarizedMessages: partition.toSummarize.length,
      retainedMessages: partition.retainedTail.length,
      summarizedEntries: partition.summarizedEntries,
      summarizedTurns: partition.summarizedTurns,
      modelCalls: 1,
    };
  }

  async createIncrementalDraft(options: {
    built: BuiltSessionContext;
    selectedUserEntryId: string;
    requestTokensBefore: number;
    workspaceDiffStat: string;
    signal: AbortSignal;
    forkContext: Context;
  }): Promise<IncrementalSquashDraft> {
    const selectedIndex = options.built.origins.findIndex(
      (origin) => origin.kind === "entry" && origin.entryId === options.selectedUserEntryId,
    );
    if (selectedIndex < 0 || options.built.messages[selectedIndex]?.role !== "user") {
      throw new Error(`Selected squash entry is not a structural user message in the active context: ${options.selectedUserEntryId}`);
    }
    const selectedOrdinal = this.forkUserOrdinal(
      options.built,
      options.forkContext,
      this.userOrdinal(options.built.messages, selectedIndex),
    );
    const excerpt = this.messageText(options.built.messages[selectedIndex]!).replace(/\s+/g, " ").slice(0, 160);
    const boundary = [
      `The selected boundary is user message #${selectedOrdinal} in the conversation prefix`,
      excerpt ? `(${JSON.stringify(excerpt)}).` : ".",
      "Summarize that exact message through the current leaf, inclusive.",
    ].join(" ");
    const instruction = this.withTokenLimit(
      `${INCREMENTAL_INSTRUCTION}\n\n${boundary}\n\n${READ_ONLY_FORK_RULE}`,
      this.maxIncrementalSummaryTokens,
    );
    const summary = await this.summarize(
      options.forkContext,
      instruction,
      this.maxIncrementalSummaryTokens,
      options.signal,
    );
    const coveredOrigins = options.built.origins.slice(selectedIndex);
    return {
      summaryKind: "incremental",
      summary,
      workspaceDiffStat: options.workspaceDiffStat,
      retainedTail: [],
      requestTokensBefore: options.requestTokensBefore,
      summarizedMessages: options.built.messages.length - selectedIndex,
      summarizedEntries: new Set(coveredOrigins.map((origin) => origin.entryId)).size,
      summarizedTurns: options.built.messages.slice(selectedIndex).filter((message) => message.role === "user").length,
      modelCalls: 1,
    };
  }

  async appendDraft(
    lane: string,
    parentId: string | null,
    expectedLeafId: string | null,
    draft: RootSquashDraft | IncrementalSquashDraft,
    entryId = createId("entry"),
    entryTimestamp?: number,
  ): Promise<Extract<SessionEntry, { type: "squash" }>> {
    const entry = await this.session.appendEntryAt(
      lane,
      parentId,
      {
        id: entryId,
        sessionId: this.session.store.sessionId,
        type: "squash",
        summaryKind: draft.summaryKind,
        summary: draft.summary,
        workspaceDiffStat: draft.workspaceDiffStat,
        retainedTail: structuredClone(draft.retainedTail),
        requestTokensBefore: draft.requestTokensBefore,
      },
      { expectedLeafId, flush: true, ...(entryTimestamp === undefined ? {} : { entryTimestamp }) },
    );
    return entry as Extract<SessionEntry, { type: "squash" }>;
  }

  private partitionRoot(built: BuiltSessionContext, retainedTailBudgetTokens: number): RootPartition | undefined {
    if (built.messages.length !== built.origins.length) throw new Error("Context messages and origins must align");
    const userStarts: number[] = [];
    for (let index = 0; index < built.messages.length; index++) {
      if (this.isRealUserBoundary(built.messages[index]!, built.origins[index]!)) userStarts.push(index);
    }
    if (userStarts.length <= this.minRetainTurns) return undefined;

    let retainedTurns = this.minRetainTurns;
    for (let candidate = this.minRetainTurns + 1; candidate < userStarts.length; candidate++) {
      const candidateStart = userStarts[userStarts.length - candidate]!;
      if (this.estimateTailTokens(built.messages.slice(candidateStart)) > retainedTailBudgetTokens) break;
      retainedTurns = candidate;
    }
    const tailStart = userStarts[userStarts.length - retainedTurns]!;
    const summarizedOrigins = built.origins.slice(0, tailStart);
    const retainedTail = built.messages.slice(tailStart).map((message, index) => ({
      sourceEntryId: built.origins[tailStart + index]!.entryId,
      message: structuredClone(message),
    }));
    return {
      toSummarize: structuredClone(built.messages.slice(0, tailStart)) as Message[],
      retainedTail,
      retainedStartUserOrdinal: this.userOrdinal(built.messages, tailStart),
      summarizedEntries: new Set(summarizedOrigins.map((origin) => origin.entryId)).size,
      summarizedTurns: built.messages.slice(0, tailStart).filter((message) => message.role === "user").length,
    };
  }

  private isRealUserBoundary(message: Message, origin: MessageOrigin): boolean {
    if (message.role !== "user") return false;
    const source = this.session.projection.entries.get(origin.entryId);
    return source?.type === "message" && source.message.role === "user";
  }

  private userOrdinal(messages: readonly Message[], inclusiveIndex: number): number {
    let ordinal = 0;
    for (let index = 0; index <= inclusiveIndex; index++) {
      if (messages[index]?.role === "user") ordinal++;
    }
    return ordinal;
  }

  private forkUserOrdinal(
    built: BuiltSessionContext,
    forkContext: Context,
    builtUserOrdinal: number,
  ): number {
    const serializedBuilt = built.messages.map((message) => JSON.stringify(message));
    const serializedFork = forkContext.messages.map((message) => JSON.stringify(message));
    let start = -1;
    for (let candidate = 0; candidate + serializedBuilt.length <= serializedFork.length; candidate++) {
      if (serializedBuilt.every((message, index) => message === serializedFork[candidate + index])) {
        start = candidate;
        break;
      }
    }
    if (start < 0) {
      throw new Error("The active context extension changed session messages, so a precise squash boundary cannot be identified");
    }
    const userMessagesBefore = forkContext.messages.slice(0, start).filter((message) => message.role === "user").length;
    return userMessagesBefore + builtUserOrdinal;
  }

  private messageText(message: Message): string {
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.type === "text" ? block.text : "")
      .join("\n");
  }

  private estimateTailTokens(messages: readonly Message[]): number {
    const marker: Message = { role: "user", content: "", timestamp: Number.MAX_SAFE_INTEGER };
    return estimateContextTokens([marker, ...messages]).tokens;
  }

  private async summarize(
    forkContext: Context,
    instruction: string,
    maxTokens: number,
    signal: AbortSignal,
  ): Promise<string> {
    const forkTokens = estimateContextTokens({
      ...forkContext,
      messages: [...forkContext.messages, { role: "user", content: instruction, timestamp: Date.now() }],
    }).tokens;
    const ceiling = this.model.contextWindow - this.safetyTokens - maxTokens;
    if (forkTokens > ceiling) {
      throw new Error(
        `Context is too large to squash: the forked request needs about ${forkTokens.toLocaleString("en-US")} tokens but only ${Math.max(0, ceiling).toLocaleString("en-US")} are available. Use /clear or /rewind to reduce it.`,
      );
    }
    const summary = await this.model.forkComplete(forkContext, instruction, {
      signal,
      maxTokens,
      ...(this.reasoning ? { reasoning: this.reasoning } : {}),
    });
    if (!summary.trim()) throw new Error("Squash model returned an empty summary");
    return summary.trim();
  }

  private withTokenLimit(prompt: string, maxTokens: number): string {
    return `${prompt}\n\nYour response must not exceed ${maxTokens.toLocaleString("en-US")} tokens. Use less when the continuation context is already complete; never add filler.`;
  }
}
