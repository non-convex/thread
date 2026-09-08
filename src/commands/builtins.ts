import type { SessionEntry } from "../session-tree/model.js";
import type { ThreadCommand, CommandRegistry, HistoryViewItem, ThreadCommandContext } from "./types.js";
import { ephemeral, viewResult } from "./types.js";

type HistorySnapshot = ReturnType<ThreadCommandContext["runtime"]["readHistory"]>;

function short(id: string | null): string {
  if (id === null) return "root";
  return id.length > 18 ? id.slice(0, 18) : id;
}

const status: ThreadCommand = {
  name: "status",
  description: "Show the project Session Tree and active Session.",
  async execute(_args, context) {
    context.signal.throwIfAborted();
    const snapshot = context.runtime.readHistory();
    const tree = snapshot.tree;
    const content = [
      `project: ${tree.projectId}`,
      `session tree: ${tree.id}`,
      `active session: ${context.selectedSessionId}`,
      `live tip: ${snapshot.liveTips[context.selectedSessionId] ?? "root"}`,
      `sessions: ${snapshot.sessions.length}`,
      `turns: ${snapshot.turns.length}`,
      ...(context.skills?.length ? [`skills: ${context.skills.map((skill) => skill.name).join(", ")}`] : []),
      ...(context.skillDiagnostics ?? []).map((item) => `skill ${item.kind}: ${item.message} (${item.path})`),
    ].join("\n");
    return viewResult(content, { type: "document", title: "Session Tree status", content });
  },
};

function requestLabel(entry: SessionEntry | undefined): string {
  const text = entry?.type === "message" && entry.message.role === "user"
    ? (typeof entry.message.content === "string"
      ? entry.message.content
      : entry.message.content.filter((block) => block.type === "text")
          .map((block) => block.type === "text" ? block.text : "").join(" "))
    : "";
  return text.replace(/\s+/g, " ").slice(0, 140) || "(no request text)";
}

function requestLabels(snapshot: HistorySnapshot): Map<string, string> {
  const entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  return new Map(snapshot.turns.map((turn) => [turn.id, requestLabel(entries.get(turn.userEntryId))]));
}

const sessions: ThreadCommand = {
  name: "sessions",
  description: "List root Sessions and their saved live tips.",
  async execute(_args, context) {
    context.signal.throwIfAborted();
    const summaries = context.runtime.listSessions().map((session) => ({
      ...session,
      active: session.sessionId === context.selectedSessionId,
    }));
    const labels = requestLabels(context.runtime.readHistory());
    const lines = summaries.map((session) =>
      `${session.active ? "*" : " "} ${session.sessionId} tip=${short(session.liveTipTurnId)} turns=${session.turnCount} created=${new Date(session.createdAt).toISOString()}`
    );
    return viewResult(lines.join("\n"), {
      type: "command_picker",
      title: "Sessions · opening leaves workspace files unchanged",
      items: summaries.map((session) => ({
        label: session.liveTipTurnId ? labels.get(session.liveTipTurnId) ?? "(no request text)" : "Root (no active turns)",
        description: `${session.sessionId} · ${new Date(session.createdAt).toLocaleString()} · ${session.turnCount} turns`,
        command: `/session ${session.sessionId}`,
        submit: true,
        current: session.active,
      })),
    });
  },
};

const open: ThreadCommand = {
  name: "open",
  description: "Resume a root Session without changing workspace files.",
  async execute(args, context) {
    if (args.length === 0) return sessions.execute([], context);
    if (args.length !== 1) throw new Error("Usage: /thread open <session-id>");
    context.signal.throwIfAborted();
    const session = await context.openSession(args[0]!);
    return ephemeral(`Opened Session ${session.id}; workspace left unchanged`, true);
  },
};

function allHistoryItems(context: ThreadCommandContext, snapshot: HistorySnapshot): HistoryViewItem[] {
  const activeSessionId = context.selectedSessionId;
  const activePathIds = new Set(context.runtime.readSession(activeSessionId).turns.map((turn) => turn.id));
  const labels = requestLabels(snapshot);
  return snapshot.turns
    .sort((left, right) => right.startedAt - left.startedAt)
    .map((turn) => {
      return {
        turnId: turn.id,
        userEntryId: turn.userEntryId,
        label: labels.get(turn.id) ?? "(no request text)",
        outcome: turn.status,
        startedAt: turn.startedAt,
        status: turn.sessionId !== activeSessionId
          ? "other-session"
          : activePathIds.has(turn.id) ? "current-path" : "current-session-off-path",
      };
    });
}

export function buildRewindItems(context: ThreadCommandContext): HistoryViewItem[] {
  return context.runtime.rewindCandidates(context.selectedSessionId).slice().reverse().map((candidate) => ({
    turnId: candidate.turnId,
    userEntryId: candidate.userEntryId,
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
    const snapshot = context.runtime.readHistory();
    const items = allHistoryItems(context, snapshot);
    const itemByTurn = new Map(items.map((item) => [item.turnId, item]));
    const lines: string[] = [`Root ${snapshot.tree.rootId}`];
    const sessions = snapshot.sessions.sort((left, right) => left.createdAt - right.createdAt);
    for (const session of sessions) {
      const active = session.id === context.selectedSessionId ? " active" : "";
      lines.push(`├─ Session ${session.id}${active}`);
      const turns = snapshot.turns
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
          const live = snapshot.liveTips[session.id] === turn.id ? " live" : "";
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
    context.signal.throwIfAborted();
    if (!context.runtime.recallEnabled) return ephemeral("Session recall is disabled");
    if (args.length === 0) return viewResult("Usage: /thread search <query> [<query> ...]", {
      type: "composer",
      text: "/thread search ",
      hint: "Enter a search query, then press Enter.",
    });
    const result = await context.runtime.searchHistory(args, { limit: 20, signal: context.signal });
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
