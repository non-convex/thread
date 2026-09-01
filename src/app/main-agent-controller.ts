import type { CacheRetention, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelClient } from "../agent/model-client.js";
import type { ThreadState } from "../config/thread-state.js";

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Owns only the primary agent's mutable model and thinking selection. */
export class MainAgentController {
  private currentModel: ModelClient | undefined;
  private preferredThinkingLevel: ModelThinkingLevel;
  private currentThinkingLevel: ModelThinkingLevel = "off";

  constructor(
    private readonly treeId: string,
    private readonly cacheRetention: CacheRetention | undefined,
    preferredThinkingLevel: ModelThinkingLevel,
    private readonly onStateChange?: (state: Pick<ThreadState, "model" | "thinkingLevel">) => void,
  ) {
    this.preferredThinkingLevel = preferredThinkingLevel;
  }

  get model(): ModelClient | undefined { return this.currentModel; }
  get thinkingLevel(): ModelThinkingLevel { return this.currentThinkingLevel; }
  get supportsThinking(): boolean { return this.currentModel?.reasoning === true; }
  get availableThinkingLevels(): readonly ModelThinkingLevel[] { return this.thinkingLevelsFor(this.currentModel); }
  get reasoning(): ThinkingLevel | undefined { return this.currentThinkingLevel === "off" ? undefined : this.currentThinkingLevel; }

  select(model: ModelClient | undefined): void {
    this.currentModel = this.bind(model);
    this.currentThinkingLevel = this.clamp(this.currentModel, this.preferredThinkingLevel);
  }

  cycleThinkingLevel(): ModelThinkingLevel | undefined {
    if (!this.currentModel?.reasoning) return undefined;
    const levels = this.thinkingLevelsFor(this.currentModel);
    const index = levels.indexOf(this.currentThinkingLevel);
    this.preferredThinkingLevel = levels[(index + 1) % levels.length]!;
    this.currentThinkingLevel = this.clamp(this.currentModel, this.preferredThinkingLevel);
    this.remember();
    return this.currentThinkingLevel;
  }

  remember(): void {
    this.onStateChange?.({
      ...(this.currentModel ? { model: { provider: this.currentModel.providerId, id: this.currentModel.modelId } } : {}),
      thinkingLevel: this.preferredThinkingLevel,
    });
  }

  private bind(model: ModelClient | undefined): ModelClient | undefined {
    if (!model) return undefined;
    let bound = model;
    const cacheBindable = bound as ModelClient & { withCacheKey?: (key: string) => ModelClient };
    if (cacheBindable.withCacheKey && bound.cacheKey !== this.treeId) bound = cacheBindable.withCacheKey(this.treeId);
    const retentionBindable = bound as ModelClient & { withCacheRetention?: (value: CacheRetention | undefined) => ModelClient };
    if (retentionBindable.withCacheRetention && bound.cacheRetention !== this.cacheRetention) {
      bound = retentionBindable.withCacheRetention(this.cacheRetention);
    }
    return bound;
  }

  private thinkingLevelsFor(model: ModelClient | undefined): readonly ModelThinkingLevel[] {
    if (!model?.reasoning) return ["off"];
    const levels = model.supportedThinkingLevels?.filter((level, index, all) => all.indexOf(level) === index);
    return levels?.length ? levels : ["off", "minimal", "low", "medium", "high"];
  }

  private clamp(model: ModelClient | undefined, requested: ModelThinkingLevel): ModelThinkingLevel {
    const available = this.thinkingLevelsFor(model);
    if (available.includes(requested)) return requested;
    const target = THINKING_LEVELS.indexOf(requested);
    return [...available].sort((left, right) =>
      Math.abs(THINKING_LEVELS.indexOf(left) - target) - Math.abs(THINKING_LEVELS.indexOf(right) - target)
    )[0] ?? "off";
  }
}
