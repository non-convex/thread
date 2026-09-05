import { listSessionHistory } from "../session-tree/history.js";
import type { ThreadCommand, CommandRegistry, HistoryViewItem, ThreadCommandContext } from "./types.js";
import { ephemeral, viewResult } from "./types.js";

function short(id: string | null): string {
  if (id === null) return "root";
  return id.length > 18 ? id.slice(0, 18) : id;
}

const status: ThreadCommand = {
  name: "status",
  description: "Show the project Session Tree and active Session.",
  async execute(_args, context) {
    context.signal.throwIfAborted();
    const tree = context.tree.tree;
    return ephemeral([
      `project: ${tree.projectId}`,
      `session tree: ${tree.id}`,
      `active session: ${context.tree.activeSession.id}`,
      `live tip: ${context.tree.activeLiveTip ?? "root"}`,
      `sessions: ${context.tree.projection.sessions.size}`,
      `turns: ${context.tree.projection.turns.size}`,
      ...(context.skills?.length ? [`skills: ${context.skills.map((skill) => skill.name).join(", ")}`] : []),
      ...(context.skillDiagnostics ?? []).map((item) => `skill ${item.kind}: ${item.message} (${item.path})`),
    ].join("\n"));
  },
};

const sessions: ThreadCommand = {
  name: "sessions",
  description: "List root Sessions and their saved live tips.",
  async execute(_args, context) {
    context.signal.throwIfAborted();
    const lines = listSessionHistory(context.tree).map((session) =>
      `${session.active ? "*" : " "} ${session.sessionId} tip=${short(session.liveTipTurnId)} turns=${session.turnCount} created=${new Date(session.createdAt).toISOString()}`
    );
    return ephemeral(lines.join("\n"));
  },
};

const open: ThreadCommand = {
  name: "open",
  description: "Resume a root Session without changing workspace files.",
  async execute(args, context) {
    if (args.length !== 1) throw new Error("Usage: /thread open <session-id>");
    context.signal.throwIfAborted();
    const session = await context.tree.openSession(args[0]!);
    return ephemeral(`Opened Session ${session.id}; workspace left unchanged`, true);
  },
};

function allHistoryItems(context: ThreadCommandContext): HistoryViewItem[] {
  const activeSessionId = context.tree.activeSession.id;
  const activePathIds = new Set(context.tree.livePath().map((turn) => turn.id));
  return [...context.tree.projection.turns.values()]
    .sort((left, right) => right.startedAt - left.startedAt)
    .map((turn) => {
      const entry = context.tree.projection.entries.get(turn.userEntryId);
      const text = entry?.type === "message" && entry.message.role === "user"
        ? (typeof entry.message.content === "string"
          ? entry.message.content
          : entry.message.content.filter((block) => block.type === "text")
              .map((block) => block.type === "text" ? block.text : "").join(" "))
        : "";
      return {
        turnId: turn.id,
        userEntryId: turn.userEntryId,
        workspaceStateId: turn.workspaceStateId,
        label: text.replace(/\s+/g, " ").slice(0, 140) || "(empty user message)",
        outcome: turn.status,
        startedAt: turn.startedAt,
        status: turn.sessionId !== activeSessionId
          ? "other-session"
          : activePathIds.has(turn.id) ? "current-path" : "current-session-off-path",
      };
    });
}

export function buildRewindItems(context: ThreadCommandContext): HistoryViewItem[] {
  return context.tree.rewindCandidates().slice().reverse().map((candidate) => ({
    turnId: candidate.turnId,
    userEntryId: candidate.userEntryId,
    workspaceStateId: candidate.workspaceStateId,
    label: candidate.label,
    outcome: candidate.status,
    startedAt: candidate.startedAt,
    status: "current-path",
  }));
}

const history: ThreadCommand = {
  name: "history",
  description: "Show turns across the whole project Session Tree.",
  async execute(_args, context) {
    context.signal.throwIfAborted();
    const items = allHistoryItems(context);
    const itemByTurn = new Map(items.map((item) => [item.turnId, item]));
    const lines: string[] = [`Root ${context.tree.tree.rootId}`];
    const sessions = [...context.tree.projection.sessions.values()].sort((left, right) => left.createdAt - right.createdAt);
    for (const session of sessions) {
      const active = session.id === context.tree.activeSession.id ? " active" : "";
      lines.push(`├─ Session ${session.id}${active}`);
      const turns = [...context.tree.projection.turns.values()]
        .filter((turn) => turn.sessionId === session.id)
        .sort((left, right) => left.startedAt - right.startedAt);
      const children = new Map<string | null, typeof turns>();
      for (const turn of turns) {
        const siblings = children.get(turn.parentTurnId) ?? [];
        siblings.push(turn);
        children.set(turn.parentTurnId, siblings);
      }
      const render = (parentId: string | null, depth: number): void => {
        for (const turn of children.get(parentId) ?? []) {
          const item = itemByTurn.get(turn.id)!;
          const live = context.tree.projection.liveTips.get(session.id) === turn.id ? " live" : "";
          lines.push(`${"│  ".repeat(depth + 1)}├─ ${short(turn.id)} ${item.outcome}${live} — ${item.label}`);
          render(turn.id, depth + 1);
        }
      };
      render(null, 0);
      if (turns.length === 0) lines.push("│  └─ (empty)");
    }
    const content = lines.join("\n");
    return viewResult(content, { type: "document", title: "Session Tree history", content });
  },
};

const search: ThreadCommand = {
  name: "search",
  description: "Search text across all Sessions and historical paths.",
  async execute(args, context) {
    if (args.length === 0) throw new Error("Usage: /thread search <query> [<query> ...]");
    context.signal.throwIfAborted();
    const result = await context.recall.search(args, 20, context.signal);
    const content = result.hits.length
      ? result.hits.map((hit) =>
        `${short(hit.turnId)} session=${short(hit.sessionId)} ${hit.pathStatus} kind=${hit.kind} ${hit.sources.join(", ")}\n  ${hit.snippet}`
      ).join("\n")
      : "(no related turns found)";
    const display = [`Keyword coverage: ${result.coverage.keywordTurns}/${result.coverage.totalTurns}; semantic: ${result.semantic} (${result.coverage.semanticTurns}/${result.coverage.totalTurns})`,
      ...result.diagnostics, content].join("\n");
    return viewResult(display, { type: "document", title: "Session Tree search", content: display });
  },
};

export function registerBuiltinCommands(registry: CommandRegistry): void {
  for (const command of [status, sessions, open, history, search]) registry.register(command);
}
