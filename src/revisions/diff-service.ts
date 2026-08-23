import type { ContextCapsule } from "../domain.js";
import type { SemanticRunner } from "../agent/semantic-runner.js";
import type { DerivedCache } from "../persistence/cache.js";
import type { ContextDiffFacts, SessionService } from "../session/service.js";
import { sha256 } from "../utils/id.js";
import type { WorkspaceFileDiff } from "../workspace/sidecar-store.js";
import type { CapsuleService } from "./capsule-service.js";
import type { VersionService } from "./version-service.js";

const DIFF_PROMPT_VERSION = "thread-diff-v2";
const DIFF_MAX_TOKENS = 4_000;
const DIFF_SYSTEM_PROMPT = [
  "Produce a directional semantic diff from the FROM thread version to the TO thread version.",
  "This is not merely a source-code diff: give highest priority to how the agent's working context evolved, including",
  "changes to the goal, user requirements or corrections, constraints, decisions and rationale, agent understanding,",
  "validation conclusions, unresolved work, uncertainty, and the next useful action. Then explain the material",
  "workspace changes and their likely effect. Describe what was added, removed, revised, completed, invalidated, or",
  "left unresolved in TO relative to FROM; do not write two independent summaries.",
  "Use the deterministic version facts and workspace patch as authoritative for repository state. Context Capsules are",
  "lossy semantic snapshots and are authoritative only as evidence of each version's working context. If a Capsule",
  "reports intended or claimed code work that the workspace evidence does not establish, describe it as context or",
  "intent rather than a verified code change. The selected patch may be incomplete because of an input budget, so do",
  "not infer that omitted files or hunks are unchanged. Distinguish facts from interpretation in the wording, preserve",
  "meaningful uncertainty, and do not invent omitted details.",
  "Prefer a concise synthesis over a file-by-file or message-by-message inventory. Mention identifiers, counts, hashes,",
  "and raw patch details only when they help explain a meaningful change. Natural-language prose with useful headings",
  `is welcome, but no schema is required. The response must not exceed ${DIFF_MAX_TOKENS.toLocaleString("en-US")} tokens; use less when the meaningful diff is complete, and never add filler.`,
].join(" ");

export interface ThreadDiffFacts {
  from: { ref: string; checkpointId: string };
  to: { ref: string; checkpointId: string };
  commonAncestorCheckpointId: string | null;
  workspace: { files: WorkspaceFileDiff[] };
  context: ContextDiffFacts;
  factsDigest: string;
}

export interface ThreadDiffResult {
  facts: ThreadDiffFacts;
  semantic?: string;
  semanticError?: string;
  cached: boolean;
}

function capsuleText(capsule: ContextCapsule): string {
  return capsule.status === "ready" ? (capsule.content ?? "") : `[capsule unavailable: ${capsule.error ?? "unknown"}]`;
}

function patchWithinBudget(patch: string, maxChars: number): string {
  if (patch.length <= maxChars) return patch;
  const blocks = patch.split(/(?=^diff --git )/m).filter(Boolean);
  const selected: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const block of blocks) {
    const header = block.split(/\r?\n/, 1)[0] ?? "unknown diff";
    if (used + block.length <= maxChars) {
      selected.push(block);
      used += block.length;
    } else {
      omitted.push(header);
    }
  }
  return `${selected.join("")}\n[Patch hunks omitted by budget: ${omitted.join("; ")}]`;
}

export class DiffService {
  constructor(
    private readonly versions: VersionService,
    private readonly session: SessionService,
    private readonly capsules: CapsuleService,
    private readonly cache: DerivedCache,
    private readonly semantic?: SemanticRunner,
  ) {}

  async facts(fromLabel: string, toLabel: string): Promise<ThreadDiffFacts> {
    const fromRef = this.versions.resolve(fromLabel);
    const toRef = this.versions.resolve(toLabel);
    const from = this.versions.getCheckpoint(fromRef.checkpointId);
    const to = this.versions.getCheckpoint(toRef.checkpointId);
    const withoutDigest = {
      from: { ref: fromLabel, checkpointId: from.id },
      to: { ref: toLabel, checkpointId: to.id },
      commonAncestorCheckpointId: this.versions.bestCommonAncestor(from.id, to.id),
      workspace: { files: await this.versions.workspace.diffTrees(from.workspaceTreeOid, to.workspaceTreeOid) },
      context: this.session.contextDiff(from.sessionHeadId, to.sessionHeadId),
    };
    return { ...withoutDigest, factsDigest: sha256(JSON.stringify(withoutDigest)) };
  }

  async patch(fromLabel: string, toLabel: string, paths?: readonly string[]): Promise<string> {
    const from = this.versions.getCheckpoint(this.versions.resolve(fromLabel).checkpointId);
    const to = this.versions.getCheckpoint(this.versions.resolve(toLabel).checkpointId);
    return this.versions.workspace.patch(from.workspaceTreeOid, to.workspaceTreeOid, paths);
  }

  async diff(fromLabel: string, toLabel: string, signal: AbortSignal, factsOnly = false): Promise<ThreadDiffResult> {
    const facts = await this.facts(fromLabel, toLabel);
    if (factsOnly || !this.semantic) {
      return {
        facts,
        ...(factsOnly ? {} : { semanticError: "No semantic model is configured" }),
        cached: false,
      };
    }
    try {
      const fromCheckpoint = this.versions.getCheckpoint(facts.from.checkpointId);
      const toCheckpoint = this.versions.getCheckpoint(facts.to.checkpointId);
      const [fromCapsule, toCapsule, patch] = await Promise.all([
        this.capsules.getOrGenerate(fromCheckpoint, "diff", signal),
        this.capsules.getOrGenerate(toCheckpoint, "diff", signal),
        this.versions.workspace.patch(fromCheckpoint.workspaceTreeOid, toCheckpoint.workspaceTreeOid),
      ]);
      const key = sha256(
        [
          facts.factsDigest,
          sha256(capsuleText(fromCapsule)),
          sha256(capsuleText(toCapsule)),
          DIFF_PROMPT_VERSION,
          this.semantic.modelLabel,
        ].join(":"),
      );
      const cached = await this.cache.readText("diffs", key);
      if (cached !== undefined) return { facts, semantic: cached, cached: true };
      const prompt = [
        `FROM VERSION — LOSSY CONTEXT CAPSULE\nRef: ${fromLabel}\nCheckpoint: ${fromCheckpoint.id}\n${capsuleText(fromCapsule)}`,
        `TO VERSION — LOSSY CONTEXT CAPSULE\nRef: ${toLabel}\nCheckpoint: ${toCheckpoint.id}\n${capsuleText(toCapsule)}`,
        `DETERMINISTIC VERSION FACTS — AUTHORITATIVE\n${JSON.stringify(facts, null, 2)}`,
        `SELECTED DIRECTIONAL WORKSPACE PATCH — FROM → TO; MAY BE INCOMPLETE\n${patchWithinBudget(patch, 60_000) || "(no textual patch)"}`,
      ].join("\n\n");
      const semantic = await this.semantic.run({
        systemPrompt: DIFF_SYSTEM_PROMPT,
        prompt,
        maxTokens: DIFF_MAX_TOKENS,
        signal,
      });
      await this.cache.writeText("diffs", key, semantic);
      return { facts, semantic, cached: false };
    } catch (error) {
      return { facts, semanticError: error instanceof Error ? error.message : String(error), cached: false };
    }
  }
}
