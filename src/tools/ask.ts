import { Type } from "@earendil-works/pi-ai";
import {
  ASK_HEADER_MAX_CHARS,
  ASK_MAX_OPTIONS,
  ASK_MAX_QUESTIONS,
  ASK_MIN_OPTIONS,
  AskDismissedError,
  createAskRequest,
  type AskQuestion,
} from "../ui/ask.js";
import type { AgentTool, ToolResult } from "./types.js";

const optionSchema = Type.Object({
  label: Type.String({ description: "Display text, one to five words." }),
  description: Type.String({ description: "What choosing this means, including the trade-off." }),
});

/**
 * Structured mid-turn question. Implemented as an ordinary tool so the exchange
 * lands in session history as a normal call and result: compaction, rewind and
 * branching need no special case for it.
 *
 * The turn parks while the panel is open. That is the point — the loop stops
 * rather than pressing on with a guess — but it also means the tool only exists
 * when an interactive front end is there to answer.
 */
export function createAskTool(): AgentTool<{ questions: AskQuestion[] }> {
  return {
    name: "ask",
    description: [
      "Ask the user to decide between concrete alternatives, and wait for the answer.",
      "Reserve it for a fork where several approaches are genuinely valid and the choice",
      "changes the implementation: prefer reading the code over asking, and prefer stating",
      "a reasonable default over asking about something minor.",
      "A free-text option is added automatically, so never write your own catch-all choice.",
      "If you have a recommendation, put it first and end its label with (Recommended).",
    ].join(" "),
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String({ description: "The complete question, ending in a question mark." }),
          header: Type.String({
            description: `Short label for the panel, at most ${ASK_HEADER_MAX_CHARS} characters.`,
          }),
          options: Type.Array(optionSchema, {
            minItems: ASK_MIN_OPTIONS,
            maxItems: ASK_MAX_OPTIONS,
            description: `${ASK_MIN_OPTIONS} to ${ASK_MAX_OPTIONS} mutually exclusive choices.`,
          }),
          multiple: Type.Optional(
            Type.Boolean({ description: "Allow selecting more than one option. Defaults to false." }),
          ),
        }),
        {
          minItems: 1,
          maxItems: ASK_MAX_QUESTIONS,
          description: `1 to ${ASK_MAX_QUESTIONS} questions, asked together in one panel.`,
        },
      ),
    }),
    /* Nothing outside the conversation changes, and the answer is durable as this
     * call's result, so a recovered session reads it back instead of re-asking. */
    replay: "safe",
    async execute(args, context) {
      if (!context.ask) {
        return {
          content: "No interactive user is attached to this session, so questions cannot be asked. Choose a reasonable default, state the assumption, and continue.",
          isError: true,
        };
      }
      const invalid = validate(args.questions);
      if (invalid) return { content: invalid, isError: true };
      const request = createAskRequest(args.questions);
      try {
        const answers = await context.ask.present(request, context.signal);
        return present(args.questions, answers);
      } catch (error) {
        if (error instanceof AskDismissedError) {
          return {
            content: "The user dismissed the question without answering. Do not ask again; choose the option you would recommend, say which one you took, and continue.",
            isError: false,
          };
        }
        throw error;
      }
    },
  };
}

function validate(questions: readonly AskQuestion[]): string | undefined {
  if (questions.length === 0) return "questions cannot be empty";
  if (questions.length > ASK_MAX_QUESTIONS) return `at most ${ASK_MAX_QUESTIONS} questions per call`;
  for (const question of questions) {
    if (!question.question.trim()) return "each question needs question text";
    if (!question.header.trim()) return "each question needs a header";
    if (question.header.length > ASK_HEADER_MAX_CHARS) {
      return `header exceeds ${ASK_HEADER_MAX_CHARS} characters: ${question.header}`;
    }
    if (question.options.length < ASK_MIN_OPTIONS || question.options.length > ASK_MAX_OPTIONS) {
      return `each question needs ${ASK_MIN_OPTIONS} to ${ASK_MAX_OPTIONS} options`;
    }
    const labels = new Set<string>();
    for (const option of question.options) {
      if (!option.label.trim()) return "each option needs a label";
      if (labels.has(option.label)) return `duplicate option label: ${option.label}`;
      labels.add(option.label);
    }
  }
  return undefined;
}

/** Answers keyed by their question, so a multi-question call cannot be misread. */
function present(questions: readonly AskQuestion[], answers: readonly (readonly string[])[]): ToolResult {
  const lines = questions.map((question, index) => {
    const chosen = answers[index] ?? [];
    return `${question.question}\n  → ${chosen.length > 0 ? chosen.join(", ") : "(no answer)"}`;
  });
  return {
    content: ["The user answered:", ...lines, "", "Continue with these answers in mind."].join("\n"),
    isError: false,
    details: { answers },
  };
}
