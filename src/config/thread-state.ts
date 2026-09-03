import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createId } from "../utils/id.js";
import { getThreadHome, type ModelSelectionConfig, type ThreadConfig } from "./thread-config.js";

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

export interface ImplementationWorkerState {
  enabled: boolean;
  model?: ModelSelectionConfig;
}

export type DreamerState = ImplementationWorkerState;

/** Disposable machine-local choices made through Thread's interactive commands. */
export interface ThreadState {
  model?: ModelSelectionConfig;
  thinkingLevel?: ModelThinkingLevel;
  agents?: {
    "implementation-worker"?: ImplementationWorkerState;
    dreamer?: DreamerState;
  };
}

export function getThreadStatePath(): string {
  return path.join(getThreadHome(), DEFAULT_THREAD_STATE_FILE);
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
export async function loadThreadState(statePath = getThreadStatePath()): Promise<ThreadState | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const input = parsed as Record<string, unknown>;
  const state: ThreadState = {};
  const mainModel = modelSelection(input.model);
  if (mainModel) state.model = mainModel;
  if (isThinkingLevel(input.thinkingLevel)) state.thinkingLevel = input.thinkingLevel;

  if (typeof input.agents === "object" && input.agents !== null && !Array.isArray(input.agents)) {
    const parsedAgents: NonNullable<ThreadState["agents"]> = {};
    for (const id of ["implementation-worker", "dreamer"] as const) {
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
  return state.model || state.thinkingLevel || state.agents ? state : undefined;
}

const writeQueues = new Map<string, Promise<void>>();

/** Atomic, ordered last-writer-wins persistence for interactive state. */
export async function saveThreadState(state: ThreadState, statePath = getThreadStatePath()): Promise<void> {
  const queued = (writeQueues.get(statePath) ?? Promise.resolve()).then(
    () => writeThreadState(state, statePath),
    () => writeThreadState(state, statePath),
  );
  const settled = queued.then(() => undefined, () => undefined);
  writeQueues.set(statePath, settled);
  try {
    await queued;
  } finally {
    if (writeQueues.get(statePath) === settled) writeQueues.delete(statePath);
  }
}

async function writeThreadState(state: ThreadState, statePath: string): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${createId("tmp")}`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, statePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export interface ResolvedMainModelSelection {
  model?: ModelSelectionConfig;
  thinkingLevel?: ModelThinkingLevel;
}

export function resolveMainModelSelection(sources: {
  cli?: ModelSelectionConfig | undefined;
  state?: ThreadState | undefined;
  config?: ThreadConfig | undefined;
}): ResolvedMainModelSelection {
  const model = sources.cli ?? sources.state?.model ?? sources.config?.model;
  const thinkingLevel = sources.state?.thinkingLevel ?? sources.config?.defaultThinkingLevel;
  return {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}
