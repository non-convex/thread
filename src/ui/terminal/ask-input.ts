import type { AskService } from "../../core/runtime/interaction.js";
import type { AskScreen } from "../state.js";
import type { TerminalKey } from "./view-model.js";

export function printableKey(key: TerminalKey): string | undefined {
  if (key.ctrl || key.meta || !key.sequence || key.sequence.length !== 1) return undefined;
  const code = key.sequence.codePointAt(0)!;
  return code >= 0x20 && code !== 0x7f ? key.sequence : undefined;
}

export function isEnter(key: TerminalKey): boolean {
  return ["return", "kpenter", "linefeed"].includes(key.name);
}

/** All answer state belongs to the displayed request, including completed questions. */
export function handleAskKey(screen: AskScreen, key: TerminalKey, ask: AskService): void {
  const question = screen.request.questions[screen.questionIndex];
  if (!question) return;
  const commit = (labels: string[]) => {
    screen.answers[screen.questionIndex] = labels;
    if (screen.questionIndex + 1 === screen.request.questions.length) {
      ask.reply(screen.request.id, screen.answers);
    } else {
      screen.questionIndex++;
      screen.selected = 0;
      screen.customText = undefined;
    }
  };
  const typed = printableKey(key);
  if (typed) { screen.customText = (screen.customText ?? "") + typed; return; }
  if (screen.customText !== undefined) {
    if (key.name === "escape") screen.customText = undefined;
    else if (isEnter(key) && screen.customText.trim()) commit([screen.customText.trim()]);
    else if (key.name === "backspace") screen.customText = screen.customText.slice(0, -1);
    return;
  }
  switch (key.name) {
    case "escape": ask.dismiss(screen.request.id); return;
    case "up":
    case "down":
      if (question.options.length) screen.selected = (screen.selected + (key.name === "up" ? -1 : 1) + question.options.length) % question.options.length;
      return;
    case "space":
      if (question.multiple) {
        const chosen = screen.chosen[screen.questionIndex] ?? [];
        screen.chosen[screen.questionIndex] = chosen.includes(screen.selected)
          ? chosen.filter((index) => index !== screen.selected) : [...chosen, screen.selected];
      }
      return;
    default:
      if (isEnter(key)) {
        const chosen = screen.chosen[screen.questionIndex] ?? [];
        commit((question.multiple && chosen.length ? chosen : [screen.selected]).map((index) => question.options[index]!.label));
      }
  }
}
