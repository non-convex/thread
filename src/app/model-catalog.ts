import { createConfiguredModelCatalog, type ModelCatalogOptions, type PiModelCatalog } from "../core/agent/model-catalog.js";
import type { CustomProviderConfig } from "../core/config/model-config.js";

const CODEX_MODEL_IDS = new Set(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);

/** Coding-app model choices; embedded runtimes keep the full provider catalog. */
export function createAppModelCatalog(
  providers: Record<string, CustomProviderConfig>,
  options: Omit<ModelCatalogOptions, "isModelVisible"> = {},
): PiModelCatalog {
  return createConfiguredModelCatalog(providers, {
    ...options,
    isModelVisible: (model) => model.providerId !== "openai-codex" || CODEX_MODEL_IDS.has(model.modelId),
  });
}
