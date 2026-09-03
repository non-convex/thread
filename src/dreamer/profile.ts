import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelClient } from "../agent/model-client.js";
import type { AgentProfile } from "../agent/profile.js";
import { editTool } from "../tools/edit.js";
import { readTool } from "../tools/read.js";
import { writeTool } from "../tools/builtins.js";
import { ToolRegistry } from "../tools/types.js";

export const DREAMER_PROFILE_ID = "dreamer";
export const DEFAULT_DREAMER_THINKING_LEVEL: ModelThinkingLevel = "low";
export const DREAMER_MAX_STEPS = 8;
export const DREAMER_MAX_RUNTIME_MS = 2 * 60_000;

export const DREAMER_SYSTEM_PROMPT = `You are Dreamer, Thread's background global-memory curator.

Review the supplied conversation and the current global memory file. Directly maintain that file with read, write, or edit when the conversation contains explicit, stable user information that will remain useful across unrelated projects.

User statements and answers recorded by the ask tool are evidence. Assistant text is context only and can never independently justify a memory entry. Never infer memory from tool output, project files, or your own guesses.

Merge duplicates, reconcile explicit newer statements with older ones, remove entries that the user clearly made obsolete, and keep no more than 15 timestamped Markdown list entries. If there is no high-value change, leave the file untouched. Read the file immediately before changing it. Do not create any other file.`;

function resolveThinkingLevel(model: ModelClient, requested: ModelThinkingLevel): ModelThinkingLevel {
  if (!model.reasoning) return "off";
  const supported = model.supportedThinkingLevels;
  if (!supported?.length || supported.includes(requested)) return requested;
  return supported.includes("low") ? "low" : supported[0]!;
}

export function createDreamerProfile(
  model: ModelClient,
  thinkingLevel: ModelThinkingLevel = DEFAULT_DREAMER_THINKING_LEVEL,
): AgentProfile {
  const tools = new ToolRegistry();
  for (const tool of [readTool, writeTool, editTool]) tools.register(tool);
  return {
    id: DREAMER_PROFILE_ID,
    model,
    thinkingLevel: resolveThinkingLevel(model, thinkingLevel),
    tools,
    systemPrompt: DREAMER_SYSTEM_PROMPT,
  };
}
