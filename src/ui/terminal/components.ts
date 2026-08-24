import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { ThreadDiffFacts } from "../../revisions/diff-service.js";
import type { UiScreen, UiState } from "../state.js";
import { TerminalMarkdownRenderer } from "./markdown.js";
import { bold, columns, cyan, dim, fit, green, inverse, red, rule, shortId, yellow } from "./styles.js";

const MAX_READING_WIDTH = 180;
const MODEL_PICKER_VISIBLE = 18;

export interface TerminalMeta {
  rootPath: string;
  modelLabel: string;
  contextPercent: number;
  uncommitted: boolean;
}

function pushWrapped(lines: string[], text: string, width: number, prefix = ""): void {
  const contentWidth = Math.max(1, width - prefix.length);
  const wrapped = wrapTextWithAnsi(text || " ", contentWidth);
  for (const line of wrapped) lines.push(`${prefix}${line}`);
}

function section(lines: string[], title: string): void {
  if (lines.length > 0) lines.push("");
  lines.push(cyan(bold(title.toUpperCase())));
}

function stat(file: ThreadDiffFacts["workspace"]["files"][number]): string {
  if (file.binary) return dim("binary");
  return `${green(`+${file.additions ?? 0}`)} ${red(`-${file.deletions ?? 0}`)}`;
}

function statusLetter(status: string): string {
  if (status === "added") return green("A");
  if (status === "deleted") return red("D");
  if (status === "renamed") return yellow("R");
  return yellow("M");
}

export class HeaderComponent implements Component {
  constructor(
    private readonly state: () => UiState,
    private readonly meta: () => TerminalMeta,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.state();
    const meta = this.meta();
    let left = `${bold("thread")}  ${dim("·")}  ${fit(meta.rootPath, Math.max(18, Math.floor(width * 0.42)))}`;
    let center = "";
    let right = `${green(state.branch)}  ${dim("@")}  ${green(shortId(state.checkpointId))}`;
    if (state.screen.type === "diff") {
      const screen = state.screen;
      const facts = screen.result.facts;
      left = bold("THREAD DIFF");
      center = `${green(facts.from.ref)}  →  ${green(facts.to.ref)}`;
      right = (["summary", "context", "workspace"] as const)
        .map((tab) => tab === screen.tab ? cyan(bold(tab)) : dim(tab))
        .join("  ");
    } else if (state.screen.type === "merge") {
      left = bold("THREAD MERGE");
      center = `${green(state.screen.preview.incomingLabel)}  →  ${green(state.screen.preview.currentBranch)}`;
      right = dim("preview · nothing applied yet");
    } else if (state.screen.type === "history") {
      left = bold("SESSION HISTORY");
      center = green(state.branch);
      right = dim("restore before selected message");
    } else if (state.screen.type === "model_picker") {
      left = bold("SELECT MODEL");
      center = cyan(meta.modelLabel);
      right = state.screen.models.length > 0
        ? dim(`${state.screen.selected + 1} / ${state.screen.models.length}`)
        : dim("no models");
    } else if (state.screen.type === "document") {
      left = bold(state.screen.title.toUpperCase());
      right = dim("ephemeral · not in session");
    }
    return [columns(left, center, right, width), rule(width)];
  }
}

export class FooterComponent implements Component {
  constructor(
    private readonly state: () => UiState,
    private readonly meta: () => TerminalMeta,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.state();
    const meta = this.meta();
    if (state.screen.type === "session") {
      const left = `${green(state.branch)} ${dim("@")} ${green(shortId(state.checkpointId))}${meta.uncommitted ? `  ${yellow("uncommitted")}` : ""}`;
      const center = dim(`context ${meta.contextPercent}%`);
      return [columns(left, center, cyan(meta.modelLabel), width)];
    }
    let hint = `${cyan("esc")} back to session`;
    if (state.screen.type === "diff") hint = `${cyan("tab / 1-3")} section   ${cyan("j/k")}/arrows scroll   ${cyan("esc")} back`;
    if (state.screen.type === "merge") hint = `${cyan("↑/↓")} context strategy   ${cyan("enter")} continue   ${cyan("esc")} cancel`;
    if (state.screen.type === "history") hint = `${cyan("↑/↓")} select   ${cyan("enter")} restore   ${cyan("esc")} cancel`;
    if (state.screen.type === "model_picker") hint = `${cyan("↑/↓")} select model   ${cyan("enter")} switch   ${cyan("esc")} cancel`;
    return [columns(hint, "", `${green(state.branch)} ${dim("@")} ${green(shortId(state.checkpointId))}`, width)];
  }
}

export class StatusComponent implements Component {
  constructor(private readonly state: () => UiState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.state();
    if (state.screen.type !== "session") return [];
    if (state.busy) return [fit(`${cyan("● RUNNING")}  ${dim(state.activity ?? "working")}  ${dim("esc interrupt")}`, width)];
    if (!state.notice) return [];
    const color = state.notice.level === "error" ? red : state.notice.level === "success" ? green : cyan;
    return wrapTextWithAnsi(color(state.notice.text), Math.max(1, width));
  }
}

export class ScreenDocumentComponent implements Component {
  private readonly markdown = new TerminalMarkdownRenderer();

  constructor(private readonly state: () => UiState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const state = this.state();
    const lines = state.screen.type === "session"
      ? this.renderSession(state, width)
      : state.screen.type === "model_picker"
        ? this.renderModelPicker(state.screen, width)
      : state.screen.type === "diff"
        ? this.renderDiff(state.screen, width)
        : state.screen.type === "merge"
          ? this.renderMerge(state.screen, width)
          : state.screen.type === "history"
            ? this.renderHistory(state.screen, width)
            : this.renderDocument(state.screen, width);
    if (lines.length <= 2_000) return lines;
    return [dim("… earlier rendered history is available through /thread history …"), ...lines.slice(-1_999)];
  }

  private renderSession(state: UiState, width: number): string[] {
    const lines: string[] = [];
    for (const item of state.transcript) {
      if (lines.length > 0) lines.push("");
      if (item.kind === "tool") {
        const icon = item.isError ? red("×") : green("✓");
        lines.push(`  ${icon} ${cyan((item.label ?? "TOOL").toUpperCase())}  ${fit(item.content, Math.max(8, width - 17))}`);
        continue;
      }
      const label = item.kind === "user"
        ? bold("YOU")
        : item.kind === "assistant"
          ? cyan(bold("AGENT"))
          : item.kind === "compaction"
            ? yellow(bold("CONTEXT COMPACTED"))
            : green(bold("IMPORTED CONTEXT"));
      lines.push(label);
      this.pushMarkdown(lines, `entry:${item.id}`, item.content, width, 2);
    }
    const live = state.liveTurn;
    if (live) {
      if (lines.length > 0) lines.push("");
      lines.push(bold("YOU"));
      this.pushMarkdown(lines, `live-user:${live.id}`, live.input, width, 2);
      if (live.assistantText || live.tools.length > 0) {
        lines.push("");
        lines.push(cyan(bold("AGENT")));
        if (live.assistantText) this.pushMarkdown(lines, `live-assistant:${live.id}`, live.assistantText, width, 2);
        for (const tool of live.tools) {
          const icon = tool.status === "running" ? cyan("●") : tool.status === "failed" ? red("×") : green("✓");
          const args = this.toolArgs(tool.args);
          lines.push(`  ${icon} ${cyan(tool.name.toUpperCase())}${args ? `  ${dim(args)}` : ""}`);
          if (tool.status === "failed" && tool.result) pushWrapped(lines, tool.result.content, width, "    ");
        }
      }
    }
    if (lines.length === 0) {
      lines.push(cyan(bold("Project Session ready")));
      lines.push(dim("This conversation can branch, restore, diff and merge together with the workspace."));
      lines.push(dim("Type a task, /model to switch models, or /thread for version commands."));
    }
    return lines;
  }

  private renderModelPicker(screen: Extract<UiScreen, { type: "model_picker" }>, width: number): string[] {
    const description = screen.scope === "all"
      ? "All built-in and configured models."
      : "Configured models plus the current model. Use /model all for the complete catalog.";
    const lines: string[] = [dim(description)];
    if (screen.models.length === 0) {
      return [...lines, "", dim("No configured models are available. Use /model all to browse built-in models.")];
    }

    const count = Math.min(MODEL_PICKER_VISIBLE, screen.models.length);
    const start = Math.max(0, Math.min(screen.selected - Math.floor(count / 2), screen.models.length - count));
    const end = start + count;
    lines.push("");
    if (start > 0) lines.push(dim(`  ↑ ${start} earlier model(s)`));
    for (let index = start; index < end; index++) {
      const model = screen.models[index]!;
      const selected = index === screen.selected;
      const current = model.providerId === screen.currentProviderId && model.modelId === screen.currentModelId;
      const primary = `${selected ? "→" : " "} ${current ? "●" : " "} ${model.providerId}/${model.modelId}`;
      const details = [
        model.name !== model.modelId ? model.name : undefined,
        `${model.contextWindow.toLocaleString("en-US")} context`,
        `${model.maxOutputTokens.toLocaleString("en-US")} output`,
        model.reasoning ? "reasoning" : undefined,
      ].filter((value): value is string => value !== undefined).join(" · ");
      const row = columns(primary, "", details, width);
      lines.push(selected ? inverse(row) : current ? cyan(row) : row);
    }
    if (end < screen.models.length) lines.push(dim(`  ↓ ${screen.models.length - end} later model(s)`));
    lines.push("");
    lines.push(dim("● current model"));
    if (screen.busy) lines.push(cyan("Switching model…"));
    if (screen.error) lines.push(red(screen.error));
    return lines;
  }

  private renderDiff(screen: Extract<UiScreen, { type: "diff" }>, width: number): string[] {
    const lines: string[] = [dim("context + workspace")];
    const facts = screen.result.facts;
    if (screen.tab === "summary") {
      section(lines, "What changed");
      this.pushMarkdown(
        lines,
        `diff:${facts.factsDigest}`,
        screen.result.semantic ?? `Semantic summary unavailable: ${screen.result.semanticError ?? "not requested"}`,
        width,
      );
      this.pushContextSummary(lines, facts);
      this.pushWorkspace(lines, facts);
      if (screen.result.cached) lines.push(dim("semantic summary · cached"));
    } else if (screen.tab === "context") {
      section(lines, "Context facts");
      this.pushContextSummary(lines, facts);
      lines.push("");
      pushWrapped(lines, JSON.stringify(facts.context, null, 2), width);
    } else {
      this.pushWorkspace(lines, facts);
    }
    return lines;
  }

  private pushContextSummary(lines: string[], facts: ThreadDiffFacts): void {
    section(lines, "Context");
    const context = facts.context;
    lines.push(`${green("+")} ${context.toOnly.count} entries on target version`);
    lines.push(`${red("-")} ${context.fromOnly.count} entries only on source version`);
    lines.push(`${green("+")} ${context.userMessageCount} user messages · ${context.assistantMessageCount} assistant messages`);
    lines.push(`${green("+")} ${context.toolCallCount} tool calls · ${context.compactionCount} compactions`);
    lines.push(dim(`common entry ${context.commonAncestorEntryId ? shortId(context.commonAncestorEntryId) : "none"}`));
  }

  private pushWorkspace(lines: string[], facts: ThreadDiffFacts): void {
    section(lines, "Workspace");
    if (facts.workspace.files.length === 0) {
      lines.push(dim("No workspace changes"));
      return;
    }
    for (const file of facts.workspace.files) {
      const path = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
      lines.push(`${statusLetter(file.status)}  ${path}  ${stat(file)}`);
    }
    lines.push(dim(`${facts.workspace.files.length} files changed · facts ${shortId(facts.factsDigest, 12)}`));
  }

  private renderMerge(screen: Extract<UiScreen, { type: "merge" }>, width: number): string[] {
    const lines: string[] = [];
    const preview = screen.preview;
    section(lines, "1  Workspace merge");
    if (preview.clean) {
      lines.push(`${green("READY")}  ${preview.workspaceFiles.length} files can auto-merge`);
      for (const file of preview.workspaceFiles) lines.push(`   ${statusLetter(file.status)}  ${file.path}  ${stat(file)}`);
      if (preview.workspaceFiles.length === 0) lines.push(dim("   Workspace trees already match"));
    } else {
      lines.push(red(`BLOCKED  ${preview.conflicts.length} workspace conflict(s)`));
      for (const conflict of preview.conflicts) lines.push(`   ${red("!")}  ${red(conflict)}`);
      lines.push(dim("   v1 does not apply or edit conflicted merges."));
    }
    lines.push(dim(`base ${shortId(preview.commonAncestorCheckpointId)} · current ${shortId(preview.currentCheckpointId)} · incoming ${shortId(preview.incomingCheckpointId)}`));

    section(lines, "2  Context strategy");
    const keep = screen.selected === "keep-current";
    lines.push(`${keep ? cyan("◉") : "○"}  ${keep ? cyan(bold("Keep current context")) : "Keep current context"}`);
    lines.push(dim("   Discard incoming conversation; current branch continues unchanged."));
    lines.push(`${!keep ? cyan("◉") : "○"}  ${!keep ? cyan(bold("Import useful context with model")) : "Import useful context with model"}`);
    lines.push(dim("   Generate a concise handoff note; do not splice chat histories."));
    if (screen.note) {
      lines.push("");
      lines.push(cyan("HANDOFF PREVIEW"));
      lines.push(rule(Math.min(width, 100)));
      this.pushMarkdown(lines, `merge:${preview.incomingCheckpointId}`, screen.note, width);
      lines.push(rule(Math.min(width, 100)));
      lines.push(dim(`generated from ${preview.incomingLabel} context · read-only`));
    }
    if (screen.error) {
      lines.push("");
      pushWrapped(lines, red(screen.error), width);
    }
    lines.push("");
    if (!preview.clean) lines.push(red(`Merge blocked by ${preview.conflicts.length} workspace conflict(s)`));
    else if (screen.busy) lines.push(cyan("● Preparing merge…  esc interrupt"));
    else if (screen.confirm) lines.push(yellow("Press enter again to apply this merge; esc cancels."));
    else lines.push(green("Preview ready. Press enter to continue."));
    return lines;
  }

  private renderHistory(screen: Extract<UiScreen, { type: "history" }>, width: number): string[] {
    const lines: string[] = [dim("Select a user message. Restore returns workspace and context to immediately before it.")];
    if (screen.items.length === 0) return [...lines, "", dim("No turns on this thread branch.")];
    lines.push("");
    for (let index = 0; index < screen.items.length; index++) {
      const item = screen.items[index]!;
      const selected = index === screen.selected;
      const time = new Date(item.startedAt).toLocaleString();
      const value = `${selected ? "→" : " "} ${shortId(item.turnId)}  ${item.outcome.padEnd(9)}  ${time}  ${item.label}`;
      lines.push(selected ? inverse(fit(value, width)) : fit(value, width));
    }
    if (screen.confirm) {
      const selected = screen.items[screen.selected]!;
      lines.push("");
      lines.push(yellow(`Restore to checkpoint ${shortId(selected.baseCheckpointId)} before this message?`));
      lines.push(dim("Press enter again to restore both workspace and context."));
    }
    if (screen.busy) lines.push(cyan("Restoring…"));
    if (screen.error) lines.push(red(screen.error));
    return lines;
  }

  private renderDocument(screen: Extract<UiScreen, { type: "document" }>, width: number): string[] {
    return wrapTextWithAnsi(screen.content, Math.max(1, width));
  }

  private pushMarkdown(lines: string[], key: string, text: string, width: number, indent = 0): void {
    const prefix = " ".repeat(indent);
    const contentWidth = Math.max(1, Math.min(width - indent, MAX_READING_WIDTH));
    for (const line of this.markdown.render(key, text, contentWidth)) lines.push(`${prefix}${line}`);
  }

  private toolArgs(args: Record<string, unknown>): string {
    for (const key of ["path", "command", "pattern", "query"]) {
      const value = args[key];
      if (typeof value === "string") return fit(value.replace(/\s+/g, " "), 100);
    }
    const encoded = JSON.stringify(args);
    return encoded === "{}" ? "" : fit(encoded, 100);
  }
}
