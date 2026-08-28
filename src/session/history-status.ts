import type { SessionEntry, Turn } from "../domain.js";
import type { SessionService } from "./service.js";

export type TurnPathStatus = "current-path" | "retained" | "off-path" | "synthetic-squash";

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } =>
      typeof block === "object" && block !== null && "type" in block
    )
    .map((block) => block.type === "text" ? block.text ?? "" : "")
    .join(" ")
    .trim();
}

const LABEL_MAX_CHARS = 140;

export function turnLabel(entry: SessionEntry | undefined): string {
  const synthetic = entry?.type === "squash" && entry.summaryKind === "incremental";
  const text = entry?.type === "message"
    ? messageText(entry.message.content)
    : synthetic
    ? `session squashed from ${entry.parentId ?? "root"}`
    : "";
  return text.replace(/\s+/g, " ").slice(0, LABEL_MAX_CHARS) || "(empty user message)";
}

/**
 * Classifies turns against the active entry path rather than branch labels: a turn's
 * relation to the live context changes with switch/rewind/squash/restore, while the
 * branch name it recorded does not.
 */
export function createTurnPathClassifier(
  session: SessionService,
  sessionHeadId: string | null,
): (turn: Turn) => TurnPathStatus {
  const activePath = session.pathTo(sessionHeadId);
  const pathIds = new Set(activePath.map((entry) => entry.id));
  const retainedIds = new Set(
    activePath.flatMap((entry) =>
      entry.type === "squash" ? entry.retainedTail.map((item) => item.sourceEntryId) : []
    ),
  );
  return (turn) => {
    const entry = session.projection.entries.get(turn.userEntryId);
    if (entry?.type === "squash" && entry.summaryKind === "incremental") return "synthetic-squash";
    if (pathIds.has(turn.userEntryId)) return "current-path";
    if (retainedIds.has(turn.userEntryId)) return "retained";
    return "off-path";
  };
}
