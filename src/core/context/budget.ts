import type { Context, Message } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "./usage.js";

export const COMPACTION_TRIGGER_RATIO = 0.78;

export interface ContextBudget {
  requestTokens: number;
  overheadTokens: number;
}

export function contextBudget(context: Context, sessionMessages: readonly Message[]): ContextBudget {
  const marker: Message = { role: "user", content: "", timestamp: Number.MAX_SAFE_INTEGER };
  const freshRequest = estimateContextTokens({ ...context, messages: [marker, ...context.messages] }).tokens;
  const freshSession = estimateContextTokens([marker, ...sessionMessages]).tokens;
  return {
    requestTokens: Math.max(estimateContextTokens(context).tokens, freshRequest),
    overheadTokens: Math.max(0, freshRequest - freshSession),
  };
}
