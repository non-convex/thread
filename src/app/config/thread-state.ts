import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ThreadState } from "../../core/runtime/state.js";
import { atomicJson } from "../../core/utils/atomic-json.js";
import type { ModelSelectionConfig } from "../../core/config/model-config.js";
import type { Project } from "../../core/project/model.js";
import type { ThreadConfig } from "./thread-config.js";

export const DEFAULT_THREAD_STATE_FILE = "state.json";

const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function getThreadStatePath(project: Pick<Project, "statePath">): string {
  return path.join(project.statePath, DEFAULT_THREAD_STATE_FILE);
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function modelSelection(value: unknown): ModelSelectionConfig | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { provider, id } = value as Record<string, unknown>;
  return typeof provider === "string" && provider.trim() && typeof id === "string" && id.trim()
    ? { provider, id }
    : undefined;
}

/** Invalid or unreadable state is ignored because it must never prevent startup. */
export async function loadThreadState(statePath: string): Promise<ThreadState | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const input = parsed as Record<string, unknown>;
  const state: ThreadState = {};
  if (typeof input.sessions === "object" && input.sessions !== null && !Array.isArray(input.sessions)) {
    const sessions = Object.fromEntries(Object.entries(input.sessions).flatMap(([sessionId, candidate]) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return [];
      const values = candidate as Record<string, unknown>;
      const model = modelSelection(values.model);
      const thinkingLevel = isThinkingLevel(values.thinkingLevel) ? values.thinkingLevel : undefined;
      return model || thinkingLevel ? [[sessionId, {
        ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}),
      }]] : [];
    }));
    if (Object.keys(sessions).length) state.sessions = sessions;
  }

  if (typeof input.agents === "object" && input.agents !== null && !Array.isArray(input.agents)) {
    const parsedAgents: NonNullable<ThreadState["agents"]> = {};
    for (const id of ["worker", "dreamer"] as const) {
      const candidate = (input.agents as Record<string, unknown>)[id];
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
      const values = candidate as Record<string, unknown>;
      if (typeof values.enabled === "boolean") {
        const selected = modelSelection(values.model);
        parsedAgents[id] = {
          enabled: values.enabled,
          ...(selected ? { model: selected } : {}),
        };
      }
    }
    if (Object.keys(parsedAgents).length > 0) state.agents = parsedAgents;
  }
  return state.sessions || state.agents ? state : undefined;
}

const writeQueues = new Map<string, Promise<void>>();

/** Atomic, ordered last-writer-wins persistence for interactive state. */
export async function saveThreadState(state: ThreadState, statePath: string): Promise<void> {
  const queued = (writeQueues.get(statePath) ?? Promise.resolve()).then(
    () => atomicJson(statePath, state, { pretty: true }),
    () => atomicJson(statePath, state, { pretty: true }),
  );
  const settled = queued.then(() => undefined, () => undefined);
  writeQueues.set(statePath, settled);
  try {
    await queued;
  } finally {
    if (writeQueues.get(statePath) === settled) writeQueues.delete(statePath);
  }
}

export interface ResolvedMainModelSelection {
  model?: ModelSelectionConfig;
  thinkingLevel?: ModelThinkingLevel;
}

/** Startup defaults for Sessions without a saved choice; explicit CLI selection also applies to the opened Session. */
export function resolveMainModelSelection(sources: {
  cli?: ModelSelectionConfig | undefined;
  config?: ThreadConfig | undefined;
}): ResolvedMainModelSelection {
  const model = sources.cli ?? sources.config?.model;
  const thinkingLevel = sources.config?.defaultThinkingLevel;
  return {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}
