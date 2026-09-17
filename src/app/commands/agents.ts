import type { ModelCatalog } from "../../core/agent/model-catalog.js";
import type { ThreadRuntime } from "../../core/runtime/thread-runtime.js";
import { ephemeral, viewResult, type CommandResult } from "./types.js";

type AgentId = "main" | "worker" | "dreamer";
type Scope = "configured" | "all";
const labels = { main: "Main", worker: "Worker", dreamer: "Dreamer" };

/** /model and /agent share selection, listing and enable/disable behavior. */
export function agentCommand(runtime: ThreadRuntime, catalog: ModelCatalog | undefined, args: string[]): CommandResult {
  const states = {
    main: { enabled: true, model: runtime.model && { provider: runtime.model.providerId, id: runtime.model.modelId } },
    worker: { enabled: runtime.workerEnabled, model: runtime.workerModel },
    dreamer: { enabled: runtime.dreamerEnabled, model: runtime.dreamerModel },
  };
  const modelName = (id: AgentId) => {
    const model = states[id].model;
    return model ? `${model.provider}/${model.id}` : "not selected";
  };
  if (!args.length) {
    const agents = (Object.keys(states) as AgentId[]).map((id) => ({
      id, label: labels[id], enabled: states[id].enabled,
      detail: modelName(id) + (id === "dreamer" && runtime.dreamerLastError ? ` · error: ${runtime.dreamerLastError}` : ""),
    }));
    const content = [
      ...agents.map(({ id, enabled }) => `${id}: ${enabled ? "on" : "off"} · ${modelName(id)}`),
      ...(runtime.dreamerLastError ? [`dreamer last error: ${runtime.dreamerLastError}`] : []),
      ...runtime.agentProfileDiagnostics.map((item) => `${item.profileId} ${item.level}: ${item.message}`),
    ].join("\n");
    return viewResult(content, { type: "agent_picker", agents });
  }
  const [name, action, ...rest] = args;
  if (!name || !Object.hasOwn(states, name)) throw new Error(`Unknown agent: ${name}`);
  const id = name as AgentId;
  const { model, enabled } = states[id];
  const label = labels[id];
  const availableModels = (scope: Scope) => catalog
    ? scope === "all" ? (catalog.listAll?.() ?? catalog.list()) : catalog.list()
    : [];
  const view = (content: string, scope: Scope, filter = "") => viewResult(content, {
    type: "model_picker", agentId: id, models: availableModels(scope),
    currentProviderId: model?.provider, currentModelId: model?.id, scope, filter,
  });
  const picker = (scope: Scope = "configured"): CommandResult => {
    if (id === "main") {
      const current = runtime.model;
      const content = current
        ? `Current model: ${modelName(id)}\nContext window: ${current.contextWindow.toLocaleString("en-US")} tokens\nImages: ${current.acceptsImages === true ? "supported" : "not supported"}\nThinking level: ${runtime.thinkingLevel}`
        : "No model selected. Use /model list and /model <provider>/<model>.";
      return catalog ? view(content, scope) : ephemeral(content);
    }
    if (!catalog) throw new Error(`${label} model selection is unavailable`);
    const models = availableModels(scope);
    const prompt = id === "worker" ? "Choose a model to enable worker." : "Choose the Dreamer model.";
    return view(models.length
      ? `${prompt}\nPlain mode: /agent ${id} model <provider>/<model>\n${models.map((item) => `${item.providerId}/${item.modelId}`).join("\n")}`
      : `No ${id === "worker" ? "worker" : "Dreamer"} models are available. Configure a provider or log in first.`, scope);
  };
  const select = (providerId: string, modelId: string): CommandResult => {
    if (!providerId || !modelId || !catalog) {
      throw new Error(id === "main" ? "Model switching is unavailable" : `${label} model selection is unavailable`);
    }
    if (id === "main") {
      runtime.selectModel(providerId, modelId);
      return ephemeral(`Switched model from ${model ? modelName(id) : "none"} to ${providerId}/${modelId}`, true);
    }
    runtime.configureAgent(id, true, catalog.createClient(providerId, modelId));
    return ephemeral(`${label}: On · ${providerId}/${modelId}`, true);
  };
  if (!action) {
    if (id === "main") return picker();
    const content = id === "worker"
      ? enabled ? `Worker: On\nWorker model: ${modelName(id)}` : `Worker: Off${model ? `\nLast worker model: ${modelName(id)}` : ""}`
      : [`Dreamer: ${enabled ? "On" : "Off"}`, `Dreamer model: ${modelName(id)}`,
          ...(runtime.dreamerLastError ? [`Last error: ${runtime.dreamerLastError}`] : [])].join("\n");
    return viewResult(content, { type: "agent_settings", agentId: id, label, enabled });
  }
  if ((action === "on" || action === "off") && id !== "main" && !rest.length) {
    if (action === "on") return model ? select(model.provider, model.id) : picker();
    runtime.configureAgent(id, false);
    return ephemeral(`${label}: Off`, true);
  }
  if (action !== "model") {
    throw new Error("Usage: /agent [main|worker|dreamer] [model [all|list [provider]|<provider>/<model>]|on|off]");
  }
  if (!rest.length) return picker();
  if (rest.length === 1 && rest[0] === "all") return picker("all");
  if (rest[0] === "list") {
    if (!catalog || rest.length > 2) throw new Error(`Usage: ${id === "main" ? "/model" : `/agent ${id} model`} list [provider]`);
    const provider = rest[1];
    const models = provider ? (catalog.listAll?.(provider) ?? catalog.list(provider)) : availableModels("configured");
    const content = models.map((item) =>
      `${item.providerId}/${item.modelId} — ${item.name}, ${item.contextWindow.toLocaleString("en-US")} context${item.acceptsImages ? ", vision" : ""}`
    ).join("\n") || "(no models)";
    return view(content, provider ? "all" : "configured", provider ? `${provider}/` : "");
  }
  const separator = rest[0]!.indexOf("/");
  if (rest.length === 1 && separator >= 0) return select(rest[0]!.slice(0, separator), rest[0]!.slice(separator + 1));
  if (id === "main" && rest.length === 2) return select(rest[0]!, rest[1]!);
  throw new Error(id === "main" ? "Usage: /model <provider>/<model>"
    : `Usage: /agent ${id} model [all|list [provider]|<provider>/<model>]`);
}
