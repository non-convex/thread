import { runGit } from "../workspace/git.js";
import type { ThreadDiffFacts } from "../revisions/diff-service.js";
import type { CommandRegistry, ThreadCommand, ThreadCommandContext } from "./types.js";
import { ephemeral, viewResult } from "./types.js";

function requireArgs(args: string[], count: number, usage: string): void {
  if (args.length < count) throw new Error(`Usage: /thread ${usage}`);
}

function short(id: string): string {
  return id.length > 18 ? id.slice(0, 18) : id;
}

export function formatFacts(facts: ThreadDiffFacts): string {
  const files = facts.workspace.files.length
    ? facts.workspace.files
        .map((file) => {
          const stats = file.binary
            ? "binary"
            : `+${file.additions ?? 0}/-${file.deletions ?? 0}`;
          return `${file.status.padEnd(8)} ${file.oldPath ? `${file.oldPath} -> ` : ""}${file.path} (${stats})`;
        })
        .join("\n")
    : "(no workspace changes)";
  return [
    `${facts.from.ref} (${short(facts.from.checkpointId)}) -> ${facts.to.ref} (${short(facts.to.checkpointId)})`,
    `common checkpoint: ${facts.commonAncestorCheckpointId ? short(facts.commonAncestorCheckpointId) : "none"}`,
    "workspace:",
    files,
    "context:",
    JSON.stringify(facts.context, null, 2),
    `facts digest: ${facts.factsDigest}`,
  ].join("\n");
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null && "type" in block)
    .map((block) => block.type === "text" ? block.text ?? "" : "")
    .join(" ")
    .trim();
}

const status: ThreadCommand = {
  name: "status",
  description: "Show the current Project Session, thread branch and main Git branch.",
  async execute(_args, context) {
    const value = context.versions.status();
    const git = await runGit(["-C", context.rootPath, "branch", "--show-current"], { allowExitCodes: [0, 128] });
    return ephemeral(
      [
        `project session: ${value.sessionId}`,
        `thread branch: ${value.currentBranch}`,
        `thread HEAD: ${value.headCheckpointId}`,
        `workspace tree: ${value.workspaceTreeOid}`,
        `context head: ${value.sessionHeadId ?? "(empty)"}`,
        `main Git branch: ${git.stdout.toString("utf8").trim() || "(detached/unborn)"}`,
        `branches: ${value.branchCount}; thread commits: ${value.commitCount}`,
        ...context.versions.warnings.map((warning) => `warning: ${warning}`),
      ].join("\n"),
    );
  },
};

const branches: ThreadCommand = {
  name: "branches",
  description: "List thread branches.",
  async execute(_args, context) {
    const current = context.versions.currentBranch.name;
    const lines = [...context.versions.projection.branches.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((branch) => `${branch.name === current ? "*" : " "} ${branch.name} ${short(branch.headCheckpointId)}`);
    return ephemeral(lines.join("\n"));
  },
};

const branch: ThreadCommand = {
  name: "branch",
  description: "Create and switch to a thread branch.",
  async execute(args, context) {
    requireArgs(args, 1, "branch <name> [<from>]");
    const created = await context.versions.createBranch(args[0]!, args[1] ?? "HEAD", true);
    return ephemeral(`Created and switched to thread branch ${created.name} at ${created.headCheckpointId}`, true);
  },
};

const switchCommand: ThreadCommand = {
  name: "switch",
  description: "Switch workspace and context to another thread branch.",
  async execute(args, context) {
    requireArgs(args, 1, "switch <branch>");
    await context.versions.switchBranch(args[0]!);
    return ephemeral(`Switched to thread branch ${args[0]}`, true);
  },
};

const reflog: ThreadCommand = {
  name: "reflog",
  description: "Show thread branch pointer movements.",
  async execute(args, context) {
    const name = args[0] ?? context.versions.currentBranch.name;
    const lines = context.versions.projection.reflog
      .filter((entry) => entry.branchName === name)
      .slice()
      .reverse()
      .map(
        (entry) =>
          `${entry.seq.toString().padStart(5)} ${short(entry.oldCheckpointId ?? "none")} -> ${short(entry.newCheckpointId)} ${entry.reason}`,
      );
    return ephemeral(lines.join("\n") || `(no reflog entries for ${name})`);
  },
};

const log: ThreadCommand = {
  name: "log",
  description: "Show thread commits or the full checkpoint graph.",
  async execute(args, context) {
    const all = args.includes("--all");
    const graph = args.includes("--graph");
    const label = args.find((arg) => !arg.startsWith("--")) ?? "HEAD";
    const start = context.versions.resolve(label).checkpointId;
    const pending = [start];
    const seen = new Set<string>();
    const commitsByCheckpoint = new Map<string, string[]>();
    for (const commit of context.versions.projection.commits.values()) {
      const labels = commitsByCheckpoint.get(commit.checkpointId) ?? [];
      labels.push(`${short(commit.id)} ${commit.message}`);
      commitsByCheckpoint.set(commit.checkpointId, labels);
    }
    const turnsByBase = new Map<string, string[]>();
    for (const turn of context.versions.projection.turns.values()) {
      const entry = context.versions.projection.entries.get(turn.userEntryId);
      let excerpt = "";
      if (entry?.type === "message" && entry.message.role === "user") {
        excerpt = typeof entry.message.content === "string"
          ? entry.message.content
          : entry.message.content
              .filter((block) => block.type === "text")
              .map((block) => (block.type === "text" ? block.text : ""))
              .join(" ");
      }
      const labels = turnsByBase.get(turn.baseCheckpointId) ?? [];
      labels.push(`rewind ${short(turn.id)} before ${JSON.stringify(excerpt.slice(0, 80))}`);
      turnsByBase.set(turn.baseCheckpointId, labels);
    }
    const lines: string[] = [];
    while (pending.length > 0) {
      const id = pending.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const checkpoint = context.versions.getCheckpoint(id);
      const labels = commitsByCheckpoint.get(id) ?? [];
      if (all || labels.length > 0 || id === start) {
        const turnLabels = turnsByBase.get(id) ?? [];
        lines.push(
          `${graph ? (checkpoint.parentCheckpointIds.length > 1 ? "M" : "*") : ""} ${short(id)} ${checkpoint.reason}${labels.length ? ` — ${labels.join("; ")}` : ""}${all && turnLabels.length ? ` — ${turnLabels.join("; ")}` : ""}`.trim(),
        );
      }
      pending.push(...checkpoint.parentCheckpointIds);
    }
    return ephemeral(lines.join("\n"));
  },
};

const show: ThreadCommand = {
  name: "show",
  description: "Show one branch, commit or checkpoint.",
  async execute(args, context) {
    requireArgs(args, 1, "show <ref>");
    const ref = context.versions.resolve(args[0]!);
    const checkpoint = context.versions.getCheckpoint(ref.checkpointId);
    const commits = [...context.versions.projection.commits.values()].filter(
      (commit) => commit.checkpointId === checkpoint.id,
    );
    const capsule = await context.capsules.read(checkpoint.id);
    return ephemeral(JSON.stringify({ ref, checkpoint, commits, capsule }, null, 2));
  },
};

const history: ThreadCommand = {
  name: "history",
  description: "Choose a historical user message to restore from.",
  async execute(_args, context) {
    const branch = context.versions.currentBranch.name;
    const items = [...context.versions.projection.turns.values()]
      .filter((turn) => turn.branchName === branch)
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((turn) => {
        const entry = context.versions.projection.entries.get(turn.userEntryId);
        const text = entry?.type === "message" ? messageText(entry.message.content) : "";
        return {
          turnId: turn.id,
          userEntryId: turn.userEntryId,
          baseCheckpointId: turn.baseCheckpointId,
          label: text.replace(/\s+/g, " ").slice(0, 140) || "(empty user message)",
          outcome: turn.outcome,
          startedAt: turn.startedAt,
        };
      });
    const content = items.length
      ? items.map((item) => `${short(item.turnId)} ${item.outcome.padEnd(9)} ${item.label}`).join("\n")
      : `(no turns on thread branch ${branch})`;
    return viewResult(content, { type: "history", items });
  },
};

const commit: ThreadCommand = {
  name: "commit",
  description: "Create an immutable thread milestone at the current checkpoint.",
  async execute(args, context) {
    requireArgs(args, 1, "commit <message>");
    const created = await context.versions.createCommit(args.join(" "));
    const checkpoint = context.versions.getCheckpoint(created.checkpointId);
    const capsule = await context.capsules.generate(checkpoint, "commit", context.signal);
    return ephemeral(
      `Created thread commit ${created.id} at ${created.checkpointId}\nContext capsule: ${capsule.status}${capsule.error ? ` (${capsule.error})` : ""}`,
      true,
    );
  },
};

const diff: ThreadCommand = {
  name: "diff",
  description: "Compare workspace and context between two thread versions.",
  async execute(args, context) {
    const factsOnly = args.includes("--facts");
    const labels = args.filter((arg) => arg !== "--facts");
    requireArgs(labels, 2, "diff <from> <to> [--facts]");
    const result = await context.diff.diff(labels[0]!, labels[1]!, context.signal, factsOnly);
    const factsText = formatFacts(result.facts);
    const content = result.semantic
        ? `${result.semantic}\n\n--- deterministic facts ---\n${factsText}${result.cached ? "\n[semantic result from cache]" : ""}`
        : `${factsText}${result.semanticError ? `\n\nSemantic diff unavailable: ${result.semanticError}` : ""}`;
    return viewResult(content, { type: "thread_diff", result });
  },
};

const restore: ThreadCommand = {
  name: "restore",
  description: "Restore workspace, context or both from a thread version.",
  async execute(args, context) {
    const modeFlag = args.find((arg) => arg.startsWith("--"));
    const labels = args.filter((arg) => !arg.startsWith("--"));
    requireArgs(labels, 1, "restore <ref> [--workspace|--context|--both]");
    const mode = modeFlag === "--workspace" ? "workspace" : modeFlag === "--context" ? "context" : "both";
    const checkpoint = await context.versions.restore(labels[0]!, mode);
    return ephemeral(`Restored ${mode} from ${labels[0]} (${checkpoint.id})`, true);
  },
};

const merge: ThreadCommand = {
  name: "merge",
  description: "Clean-merge a version into the current thread branch.",
  async execute(args, context) {
    const strategyFlag = args.find((arg) => arg.startsWith("--context="));
    const labels = args.filter((arg) => !arg.startsWith("--context="));
    requireArgs(labels, 1, "merge <ref> [--context=keep-current|summarize]");
    if (!strategyFlag) {
      const preview = await context.merge.preview(labels[0]!);
      const details = preview.clean
        ? `${preview.workspaceFiles.length} workspace file(s) can be merged cleanly`
        : `Merge blocked by ${preview.conflicts.length} workspace conflict(s):\n${preview.conflicts.join("\n")}`;
      return viewResult(details, {
        type: "thread_merge",
        preview,
        selectedContext: "keep-current",
      });
    }
    const strategy = strategyFlag.slice("--context=".length);
    if (strategy !== "keep-current" && strategy !== "summarize") throw new Error(`Unknown context strategy: ${strategy}`);
    const result = await context.merge.merge(labels[0]!, strategy, context.signal);
    if (!result.clean) return ephemeral(`Merge has conflicts; workspace was not changed:\n${result.conflicts.join("\n")}`);
    return ephemeral(
      `Merged ${labels[0]} as ${result.checkpoint!.id}\nThread commit: ${result.commit!.id}\nContext: ${strategy}`,
      true,
    );
  },
};

export function registerBuiltinCommands(registry: CommandRegistry): void {
  for (const command of [
    status,
    branches,
    branch,
    switchCommand,
    log,
    reflog,
    show,
    history,
    commit,
    diff,
    restore,
    merge,
  ]) {
    registry.register(command);
  }
}

export async function rewindCommand(turnId: string, context: ThreadCommandContext) {
  const checkpoint = await context.versions.restoreTurnBefore(turnId);
  return ephemeral(`Rewound to before ${turnId} (${checkpoint.id})`, true);
}
