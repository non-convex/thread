import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createId } from "../utils/id.js";
import { getThreadHome, type ModelSelectionConfig, type ThreadModelConfig } from "./model-config.js";

export const DEFAULT_MODEL_STATE_FILE = "state.json";

const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Machine-local memory of the last interactive `/model` and thinking-level
 * choice. It is deliberately a separate file from `config.json`: the config is
 * hand-authored by the user (and may reference secrets by env name), so thread
 * never rewrites it. This file is disposable — deleting it only returns the
 * next start to the configured defaults.
 */
export interface ModelState {
  model?: ModelSelectionConfig;
  thinkingLevel?: ModelThinkingLevel;
}

export function getModelStatePath(): string {
  return path.join(getThreadHome(), DEFAULT_MODEL_STATE_FILE);
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Reads the remembered selection. Every failure mode — missing file, unreadable
 * file, invalid JSON, unexpected shape — yields `undefined` rather than an
 * error, because a disposable cache must never prevent thread from starting.
 */
export async function loadModelState(statePath = getModelStatePath()): Promise<ModelState | undefined> {
  let source: string;
  try {
    source = await readFile(statePath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const input = parsed as Record<string, unknown>;
  const state: ModelState = {};
  const model = input.model;
  if (typeof model === "object" && model !== null && !Array.isArray(model)) {
    const { provider, id } = model as Record<string, unknown>;
    if (typeof provider === "string" && provider.trim() && typeof id === "string" && id.trim()) {
      state.model = { provider, id };
    }
  }
  if (isThinkingLevel(input.thinkingLevel)) state.thinkingLevel = input.thinkingLevel;
  return state.model || state.thinkingLevel ? state : undefined;
}

/**
 * Serializes writes per target path. Two overlapping saves would otherwise race
 * on the final rename, which fails with EPERM on Windows; chaining them keeps
 * last-writer-wins semantics without dropping either write.
 */
const writeQueues = new Map<string, Promise<void>>();

/**
 * Writes the remembered selection through a temporary file and a rename, so a
 * concurrent reader sees either the previous or the next state and never a
 * partial one.
 */
export async function saveModelState(state: ModelState, statePath = getModelStatePath()): Promise<void> {
  const queued = (writeQueues.get(statePath) ?? Promise.resolve()).then(
    () => writeModelState(state, statePath),
    () => writeModelState(state, statePath),
  );
  writeQueues.set(statePath, queued.then(() => undefined, () => undefined));
  try {
    await queued;
  } finally {
    // Drop the queue entry once this write is the last one, so the map does not
    // retain an entry per path for the lifetime of the process.
    if (writeQueues.get(statePath) === queued) writeQueues.delete(statePath);
  }
}

async function writeModelState(state: ModelState, statePath: string): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${createId("tmp")}`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, statePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export interface ResolvedModelSelection {
  model?: ModelSelectionConfig;
  thinkingLevel?: ModelThinkingLevel;
}

/**
 * Precedence for the startup selection: an explicit CLI/environment pair wins,
 * then the remembered interactive choice, then the configured default. The
 * provider/model pair is always taken from a single source so a remembered
 * provider can never be combined with a configured model id.
 */
export function resolveModelSelection(sources: {
  cli?: ModelSelectionConfig | undefined;
  state?: ModelState | undefined;
  config?: ThreadModelConfig | undefined;
}): ResolvedModelSelection {
  const model = sources.cli ?? sources.state?.model ?? sources.config?.model;
  const thinkingLevel = sources.state?.thinkingLevel ?? sources.config?.defaultThinkingLevel;
  return {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}
