import { createId } from "../utils/id.js";

/** Spec caps: enough for a batched decision, few enough that a person still reads them. */
export const ASK_MAX_QUESTIONS = 4;
export const ASK_MIN_OPTIONS = 2;
export const ASK_MAX_OPTIONS = 4;
export const ASK_HEADER_MAX_CHARS = 30;

export interface AskOption {
  label: string;
  description: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiple?: boolean;
}

export interface AskRequest {
  id: string;
  questions: readonly AskQuestion[];
}

/** One answer per question, each a list of chosen labels or the user's own text. */
export type AskAnswers = readonly (readonly string[])[];

export class AskDismissedError extends Error {
  constructor() {
    super("The user dismissed the question without answering");
    this.name = "AskDismissedError";
  }
}
/**
 * Presents a question to whoever is driving the session and resolves with the
 * chosen labels. Only an interactive front end supplies one; without it the tool
 * is not registered at all, so the model falls back to ending its turn with the
 * options written out — which is the right behaviour when nobody can click.
 */
export interface AskPresenter {
  present(request: AskRequest, signal: AbortSignal): Promise<AskAnswers>;
}

interface Pending {
  request: AskRequest;
  resolve: (answers: AskAnswers) => void;
  reject: (error: Error) => void;
}

/**
 * Parks an in-flight question until the UI answers it. Every pending question is
 * rejected on dispose: a suspended promise would otherwise keep the turn — and
 * the process — alive after the session is gone.
 */
export class AskService implements AskPresenter {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(request: AskRequest | undefined) => void>();

  /** The question awaiting an answer, or undefined when nothing is parked. */
  get current(): AskRequest | undefined {
    return [...this.pending.values()][0]?.request;
  }

  subscribe(listener: (request: AskRequest | undefined) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  present(request: AskRequest, signal: AbortSignal): Promise<AskAnswers> {
    return new Promise<AskAnswers>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () => {
        this.pending.delete(request.id);
        this.notify();
        /* An aborted turn is not an unanswered question: the loop's own abort
         * path must see an AbortError so the whole turn settles as aborted. */
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(request.id, {
        request,
        resolve: (answers) => {
          signal.removeEventListener("abort", onAbort);
          resolve(answers);
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      this.notify();
    });
  }

  /** Answers the parked question; unknown ids are ignored as a stale reply. */
  reply(id: string, answers: AskAnswers): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.notify();
    entry.resolve(answers);
  }

  /** The user closed the panel without choosing. */
  dismiss(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    this.notify();
    entry.reject(new AskDismissedError());
  }

  dispose(): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    this.listeners.clear();
    // The session is going away, so this is an abort rather than a refusal.
    for (const entry of entries) entry.reject(new DOMException("Aborted", "AbortError"));
  }

  private notify(): void {
    const current = this.current;
    for (const listener of this.listeners) {
      try {
        listener(current);
      } catch {
        // A renderer failure must not strand the parked question.
      }
    }
  }
}

export function createAskRequest(questions: readonly AskQuestion[]): AskRequest {
  return { id: createId("ask"), questions };
}
