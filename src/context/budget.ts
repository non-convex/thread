import type { Context, Message } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "../utils/estimate.js";

export const CONTEXT_SAFETY_TOKENS = 4_096;
export const COMPACTION_TRIGGER_RATIO = 0.78;

export interface ContextBudget {
  requestTokens: number;
  outputTokens: number;
  overheadTokens: number;
}

export function contextBudget(context: Context, sessionMessages: readonly Message[], outputTokens: number): ContextBudget {
  const marker: Message = { role: "user", content: "", timestamp: Number.MAX_SAFE_INTEGER };
  const freshRequest = estimateContextTokens({ ...context, messages: [marker, ...context.messages] }).tokens;
  const freshSession = estimateContextTokens([marker, ...sessionMessages]).tokens;
  return {
    requestTokens: Math.max(estimateContextTokens(context).tokens, freshRequest),
    outputTokens,
    overheadTokens: Math.max(0, freshRequest - freshSession),
  };
}
