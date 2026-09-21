import { createHash } from "node:crypto";
import type { ExecutionIdentity } from "../runtime/policy.js";

const MAX_BASELINES = 64;
const MAX_ITEMS = 4_096;
const MAX_HASH_BYTES = 32 * 1024 * 1024;
const REQUEST_SETTINGS = [
  "model", "tool_choice", "parallel_tool_calls", "disable_parallel_tool_use",
  "thinking", "reasoning", "text", "response_format", "output_config",
  "max_tokens", "max_completion_tokens", "max_output_tokens", "temperature", "top_p",
  "prompt_cache_key", "prompt_cache_retention", "prompt_cache_options", "service_tier",
] as const;

export interface PromptCacheSectionDiagnostic {
  items: number;
  previousItems?: number;
  sharedPrefixItems?: number;
  change?: "unchanged" | "appended" | "truncated" | "changed";
  /** One-based within this section; absent when unchanged. */
  firstChangedItem?: number;
}

export type PromptCacheDiagnostic = {
  /** Full provider-formatted input, before transport compression or WebSocket continuation. */
  stage: "provider_payload";
} & ({
  status: "baseline" | "compared";
  api: string;
  historyFormat: "messages" | "responses_input";
  tools: PromptCacheSectionDiagnostic;
  system: PromptCacheSectionDiagnostic;
  history: PromptCacheSectionDiagnostic;
  previous?: { callId: string; attempt: number; timestamp: number };
  elapsedMs?: number;
  modelChanged?: boolean;
  changedSettings?: string[];
  cacheMarkersChanged?: boolean;
} | {
  status: "unavailable";
  api?: string;
  reason: "provider_payload_not_observed" | "unsupported_api" | "unsupported_payload" | "diagnostic_limit" | "diagnostic_error";
});

interface RequestIdentity {
  scope: ExecutionIdentity;
  callId: string;
  attempt: number;
  providerId: string;
  modelId: string;
  purpose: "agent" | "history_summary" | "progress_summary";
}

interface Fingerprint {
  api: string;
  historyFormat: "messages" | "responses_input";
  tools: string[];
  system: string[];
  history: string[];
  settings: Map<string, string>;
  cacheMarkers: string;
}

interface Baseline {
  fingerprint: Fingerprint;
  callId: string;
  attempt: number;
  timestamp: number;
  providerId: string;
  modelId: string;
}

class DiagnosticUnavailable extends Error {
  constructor(readonly reason: Extract<PromptCacheDiagnostic, { status: "unavailable" }>["reason"]) {
    super(reason);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** JSON object key order is not a content change. Array and content order remain significant. */
function hashValue(value: unknown, budget: { bytes: number }): string {
  const hash = createHash("sha256");
  const write = (text: string) => {
    budget.bytes += Buffer.byteLength(text);
    if (budget.bytes > MAX_HASH_BYTES) throw new DiagnosticUnavailable("diagnostic_limit");
    hash.update(text);
  };
  const visit = (item: unknown, depth: number): void => {
    if (depth > 64) throw new DiagnosticUnavailable("diagnostic_limit");
    if (Array.isArray(item)) {
      write("[");
      for (const child of item) { visit(child, depth + 1); write(","); }
      write("]");
    } else if (item !== null && typeof item === "object") {
      write("{");
      for (const key of Object.keys(item).sort()) {
        write(JSON.stringify(key)); write(":");
        visit((item as Record<string, unknown>)[key], depth + 1); write(",");
      }
      write("}");
    } else {
      write(JSON.stringify(item) ?? "undefined");
    }
  };
  visit(value, 0);
  return hash.digest("hex");
}

function fingerprint(api: string, payload: unknown): Fingerprint {
  const body = record(payload);
  if (!body) throw new DiagnosticUnavailable("unsupported_payload");
  const responses = ["openai-responses", "openai-codex-responses", "azure-openai-responses"].includes(api);
  if (!responses && api !== "anthropic-messages" && api !== "openai-completions") {
    throw new DiagnosticUnavailable("unsupported_api");
  }
  const rawHistory = responses ? body.input : body.messages;
  if (!Array.isArray(rawHistory)) throw new DiagnosticUnavailable("unsupported_payload");
  if (body.tools !== undefined && !Array.isArray(body.tools)) throw new DiagnosticUnavailable("unsupported_payload");
  const tools = (body.tools ?? []) as unknown[];
  const system: unknown[] = [];
  if (body.system !== undefined) system.push(...(Array.isArray(body.system) ? body.system : [body.system]));
  if (body.instructions !== undefined) system.push(body.instructions);
  let historyStart = 0;
  while (["system", "developer"].includes(String(record(rawHistory[historyStart])?.role ?? ""))) {
    system.push(rawHistory[historyStart++]);
  }
  const history = rawHistory.slice(historyStart);
  if (tools.length + system.length + history.length > MAX_ITEMS) throw new DiagnosticUnavailable("diagnostic_limit");

  const budget = { bytes: 0 };
  const markers: unknown[] = [];
  // Only protocol positions are stripped. A tool argument/schema property named
  // cache_control is ordinary content and must still participate in comparison.
  const stripMarker = (value: unknown, location: string): unknown => {
    const object = record(value);
    if (!object) return value;
    const { cache_control, prompt_cache_breakpoint, ...content } = object;
    if (cache_control !== undefined) markers.push([location, "cache_control", cache_control]);
    if (prompt_cache_breakpoint !== undefined) markers.push([location, "prompt_cache_breakpoint", prompt_cache_breakpoint]);
    return content;
  };
  const normalizeMessage = (value: unknown, location: string): unknown => {
    const normalized = stripMarker(value, location);
    const message = record(normalized);
    if (!message || !Array.isArray(message.content)) return normalized;
    return { ...message, content: message.content.map((block, index) => {
      const blockLocation = `${location}.content[${index}]`;
      const content = stripMarker(block, blockLocation);
      const object = record(content);
      return object?.type === "tool_result" && Array.isArray(object.content)
        ? { ...object, content: object.content.map((part, partIndex) => stripMarker(part, `${blockLocation}.content[${partIndex}]`)) }
        : content;
    }) };
  };
  if (body.cache_control !== undefined) markers.push(["request", "cache_control", body.cache_control]);
  const result = {
    api,
    historyFormat: responses ? "responses_input" as const : "messages" as const,
    tools: tools.map((item, index) => hashValue(stripMarker(item, `tools[${index}]`), budget)),
    system: system.map((item, index) => hashValue(normalizeMessage(item, `system[${index}]`), budget)),
    history: history.map((item, index) => hashValue(normalizeMessage(item, `history[${index}]`), budget)),
    settings: new Map(REQUEST_SETTINGS.filter((key) => body[key] !== undefined)
      .map((key) => [key, hashValue(body[key], budget)])),
    cacheMarkers: hashValue(markers, budget),
  };
  return result;
}

function section(current: readonly string[], previous?: readonly string[]): PromptCacheSectionDiagnostic {
  if (!previous) return { items: current.length };
  let sharedPrefixItems = 0;
  while (sharedPrefixItems < Math.min(current.length, previous.length) && current[sharedPrefixItems] === previous[sharedPrefixItems]) {
    sharedPrefixItems++;
  }
  const change = sharedPrefixItems === current.length && sharedPrefixItems === previous.length ? "unchanged"
    : sharedPrefixItems === previous.length ? "appended"
    : sharedPrefixItems === current.length ? "truncated" : "changed";
  return { items: current.length, previousItems: previous.length, sharedPrefixItems, change,
    ...(change !== "unchanged" ? { firstChangedItem: sharedPrefixItems + 1 } : {}) };
}

/** Runtime-owned, bounded, and content-free. Never infers a provider's actual cache hit. */
export class PromptCacheDiagnostics {
  private readonly baselines = new Map<string, Baseline>();

  clear(): void { this.baselines.clear(); }

  observe(payload: unknown, api: string, identity: RequestIdentity): PromptCacheDiagnostic {
    const { scope } = identity;
    const key = JSON.stringify([scope.taskId ? ["task", scope.taskId]
      : scope.sessionId ? ["session", scope.sessionId] : ["execution", scope.executionId], scope.agentId, identity.purpose]);
    try {
      const current = fingerprint(api, payload);
      const previous = this.baselines.get(key);
      const comparable = previous?.fingerprint.api === api ? previous : undefined;
      const timestamp = Date.now();
      this.baselines.delete(key);
      this.baselines.set(key, { fingerprint: current, callId: identity.callId, attempt: identity.attempt, timestamp,
        providerId: identity.providerId, modelId: identity.modelId });
      if (this.baselines.size > MAX_BASELINES) this.baselines.delete(this.baselines.keys().next().value!);
      return {
        stage: "provider_payload", status: comparable ? "compared" : "baseline", api, historyFormat: current.historyFormat,
        tools: section(current.tools, comparable?.fingerprint.tools),
        system: section(current.system, comparable?.fingerprint.system),
        history: section(current.history, comparable?.fingerprint.history),
        ...(comparable ? {
          previous: { callId: comparable.callId, attempt: comparable.attempt, timestamp: comparable.timestamp },
          elapsedMs: Math.max(0, timestamp - comparable.timestamp),
          modelChanged: comparable.providerId !== identity.providerId || comparable.modelId !== identity.modelId,
          changedSettings: REQUEST_SETTINGS.filter((key) => current.settings.get(key) !== comparable.fingerprint.settings.get(key)),
          cacheMarkersChanged: current.cacheMarkers !== comparable.fingerprint.cacheMarkers,
        } : {}),
      };
    } catch (error) {
      this.baselines.delete(key);
      return { stage: "provider_payload", status: "unavailable", api,
        reason: error instanceof DiagnosticUnavailable ? error.reason : "diagnostic_error" };
    }
  }
}
