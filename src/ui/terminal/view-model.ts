import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ComposerImage } from "../images.js";
import type { UiState } from "../state.js";

export interface TerminalMeta {
  rootPath: string;
  modelName: string;
  thinkingLevel: ModelThinkingLevel;
  supportsThinking: boolean;
  contextPercent: number;
  cacheHitPercent: number | null;
  cacheMissedTokens: number;
  cacheMissReason: "idle" | "model-changed" | "prefix-changed" | null;
  gitBranch: string | undefined;
  acceptsImages: boolean;
}

export interface SlashSuggestion {
  name: string;
  description: string;
  /** Enter executes by default; false only fills the command for further input. */
  submit?: boolean;
}

export interface TerminalKey {
  name: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
  sequence?: string;
}

export type UiNotifyKind = "live" | "full";

export interface ThreadTuiViewModel {
  readonly state: UiState;
  readonly meta: TerminalMeta;
  readonly slashSuggestions: readonly SlashSuggestion[];
  subscribe(listener: (kind: UiNotifyKind) => void): () => void;
  interrupt(): boolean;
  idleCtrlC(): boolean;
  cancelIdleExitGesture(): void;
  cycleThinkingLevel(): void;
  closeView(): void;
  handleScreenKey(key: TerminalKey): boolean;
  /** Synchronously reports whether the input was accepted; completion is handled by controller events. */
  submit(raw: string, images?: readonly ComposerImage[]): boolean;
  note(text: string, level?: "info" | "success" | "error"): void;
  requestStop(): void;
}
