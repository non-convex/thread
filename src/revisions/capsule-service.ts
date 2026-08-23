import type { ContextCapsule, InternalCheckpoint } from "../domain.js";
import type { SemanticRunner } from "../agent/semantic-runner.js";
import { semanticMessageTranscript } from "../agent/message-projection.js";
import type { DerivedCache } from "../persistence/cache.js";
import type { SessionService } from "../session/service.js";

const PROMPT_VERSION = "capsule-v4";
const CAPSULE_MAX_TOKENS = 3_000;
const CAPSULE_SYSTEM_PROMPT = [
  "Create a point-in-time Context Capsule for one immutable checkpoint in a long-lived coding-agent project session.",
  "The input is the chronological, compaction-aware active conversation that the agent would carry forward from",
  "that checkpoint. It may begin with a synthetic summary of older context; treat that as prior session state, not",
  "as a new user request. Describe the working state at the end of the input, not a turn-by-turn transcript.",
  "Give highest priority to the current project goal, explicit user requirements and corrections, constraints, key",
  "decisions and their reasons, the agent's current understanding, implemented or intended changes, material paths",
  "or symbols, validation conclusions, unresolved failures or uncertainty, and the next useful action.",
  "Later corrections and decisions supersede earlier ones unless the disagreement remains unresolved. Clearly",
  "distinguish implemented work from proposals, successful validation from failed or unrun checks, and evidence",
  "from inference. Treat tool calls and results as evidence: retain material findings and outcomes, not raw output.",
  "Do not copy file contents, search results, logs, routine navigation, or a command history. Preserve an exact",
  "command only when it is needed to reproduce an important validation or unresolved failure. Do not infer actual",
  "workspace state beyond the conversation evidence, and do not invent missing facts.",
  `Return concise natural-language free text, not JSON. The response must not exceed ${CAPSULE_MAX_TOKENS.toLocaleString("en-US")} tokens; use less when the working state is already complete, and never add filler.`,
].join(" ");

export class CapsuleService {
  constructor(
    private readonly session: SessionService,
    private readonly cache: DerivedCache,
    private readonly semantic?: SemanticRunner,
  ) {}

  get modelLabel(): string | undefined {
    return this.semantic?.modelLabel;
  }

  async read(checkpointId: string): Promise<ContextCapsule | undefined> {
    return this.cache.readJson<ContextCapsule>("capsules", checkpointId);
  }

  async getOrGenerate(
    checkpoint: InternalCheckpoint,
    trigger: ContextCapsule["trigger"],
    signal: AbortSignal,
  ): Promise<ContextCapsule> {
    const existing = await this.read(checkpoint.id);
    if (
      existing?.status === "ready" &&
      existing.promptVersion === PROMPT_VERSION &&
      (!this.semantic || existing.model === this.semantic.modelLabel)
    ) {
      return existing;
    }
    return this.generate(checkpoint, trigger, signal);
  }

  async generate(
    checkpoint: InternalCheckpoint,
    trigger: ContextCapsule["trigger"],
    signal: AbortSignal,
  ): Promise<ContextCapsule> {
    const createdAt = Date.now();
    if (!this.semantic) {
      const failed: ContextCapsule = {
        checkpointId: checkpoint.id,
        sourceSessionHeadId: checkpoint.sessionHeadId,
        trigger,
        status: "failed",
        promptVersion: PROMPT_VERSION,
        error: "No semantic model is configured",
        createdAt,
      };
      await this.cache.writeJson("capsules", checkpoint.id, failed).catch(() => undefined);
      return failed;
    }
    try {
      const context = this.session.buildContext(checkpoint.sessionHeadId);
      const content = await this.semantic.run({
        systemPrompt: CAPSULE_SYSTEM_PROMPT,
        prompt: semanticMessageTranscript(
          context.messages,
          "Active context message",
          "[The active conversation context is empty.]",
        ),
        maxTokens: CAPSULE_MAX_TOKENS,
        signal,
      });
      const ready: ContextCapsule = {
        checkpointId: checkpoint.id,
        sourceSessionHeadId: checkpoint.sessionHeadId,
        trigger,
        status: "ready",
        content,
        model: this.semantic.modelLabel,
        promptVersion: PROMPT_VERSION,
        createdAt,
      };
      await this.cache.writeJson("capsules", checkpoint.id, ready).catch(() => undefined);
      return ready;
    } catch (error) {
      const failed: ContextCapsule = {
        checkpointId: checkpoint.id,
        sourceSessionHeadId: checkpoint.sessionHeadId,
        trigger,
        status: "failed",
        model: this.semantic.modelLabel,
        promptVersion: PROMPT_VERSION,
        error: error instanceof Error ? error.message : String(error),
        createdAt,
      };
      await this.cache.writeJson("capsules", checkpoint.id, failed).catch(() => undefined);
      return failed;
    }
  }
}
