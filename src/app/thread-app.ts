import path from "node:path";
import type { ModelCatalog } from "../core/agent/model-catalog.js";
import { getThreadHome } from "../core/config/home.js";
import { GLOBAL_MEMORY_FILE } from "../core/global-memory.js";
import { ThreadRuntime } from "../core/runtime/thread-runtime.js";
import { snapshotRuntimeOptions, type ThreadRuntimeOptions } from "../core/runtime/options.js";
import { skillsDirectory } from "../core/skills/loader.js";
import { createAskTool } from "../core/tools/ask.js";
import { fileEditingPrompt } from "../core/tools/file-editing-prompt.js";
import { emitCommandEvent } from "./events.js";
import { getAuthFilePath } from "../core/auth/credential-store.js";
import { agentCommand } from "./commands/agents.js";
import { buildRewindItems, registerBuiltinCommands } from "./commands/builtins.js";
import { routeThreadCommand } from "./commands/registry.js";
import { scheduleCommand } from "./commands/schedule.js";
import { mcpCommand } from "./commands/mcp.js";
import { CommandRegistry, clearDisplayResult, ephemeral, viewResult, type CommandResult } from "./commands/types.js";
import { parseCommandLine } from "./commands/parser.js";
import { createExtensionAPI, type ExtensionAPI } from "./extensions/api.js";
import { loadExtension, type ExtensionDisposer } from "./extensions/loader.js";
import { parseInput, type GoalInputAction, type InputOptions, type InputResult, type RoutedInput } from "./input-router.js";
import type { SessionGoal } from "../core/session-tree/model.js";
import { loadProjectInstructions } from "./project-instructions.js";
import { COMMUNICATION_STYLE_PROMPT, DEFAULT_COMMIT_ATTRIBUTION, DEFAULT_SYSTEM_PROMPT, formatCommitAttributionPrompt } from "./system-prompt.js";

export type { InputResult } from "./input-router.js";

function formatGoalStatus(goal: SessionGoal): string {
  return [
    `Goal: ${goal.status} · ${goal.turnsUsed}/${goal.turnLimit} turns`,
    `Objective: ${goal.objective}`,
    ...(goal.reason ? [`Reason: ${goal.reason}`] : []),
  ].join("\n");
}
/** Product options for the coding application. Other hosts open ThreadRuntime directly. */
export interface ThreadAppOptions extends Omit<ThreadRuntimeOptions, "search" | "globalMemoryPath"> {
  search?: ThreadRuntimeOptions["search"] | false;
  globalMemoryPath?: string | false;
  commitAttribution?: string;
  /** Read rootPath/AGENTS.md once at startup. Default: true. */
  projectInstructions?: boolean;
}

/** Owns coding defaults, selected-session UI state, commands and extensions. */
export class ThreadApp {
  readonly commands = new CommandRegistry();
  readonly extensionApi: ExtensionAPI;
  selectedSessionId: string;
  private readonly skillPaths: readonly string[];
  private readonly inputOperations = new Map<Promise<InputResult>, { controller: AbortController; sessionId?: string }>();
  private readonly extensionDisposers: ExtensionDisposer[] = [];
  private extensionLoading: Promise<void> = Promise.resolve();
  private appClosing: Promise<void> | undefined;

  private constructor(readonly runtime: ThreadRuntime, private readonly catalog: ModelCatalog | undefined, skillPaths: readonly string[]) {
    this.selectedSessionId = runtime.initialSessionId;
    registerBuiltinCommands(this.commands);
    this.extensionApi = createExtensionAPI(runtime, this.commands);
    this.skillPaths = skillPaths.map((directory) => path.resolve(runtime.rootPath, directory));
  }

  private async route({ input, command, rest, goal }: RoutedInput, options: InputOptions, sessionId: string): Promise<InputResult> {
    const runtime = this.runtime;
    const usage = () => { if (rest) throw new Error(`Usage: /${command}`); };
    switch (command) {
      case undefined:
      case "exit":
        return { kind: "turn", result: await runtime.prompt(sessionId, input, options) };
      case "goal": return this.routeGoal(goal!, options, sessionId);
      case "schedule": return this.runCommand("schedule", options, () => scheduleCommand(parseCommandLine(rest), this.commandContext(options.signal, sessionId)));
      case "mcp": return this.runCommand("mcp", options, () => mcpCommand(parseCommandLine(rest), runtime, options.signal));
      case "clear": usage(); return { kind: "command", result: clearDisplayResult() };
      case "new":
        usage();
        return this.runCommand("new", options, async () => {
          const session = await runtime.createSession(options);
          this.selectedSessionId = session.id;
          const warnings = runtime.agentProfileDiagnostics.filter((item) => item.profileId === "main").map((item) => `Warning: ${item.message}`);
          return ephemeral([`Created empty Session ${session.id} from Root; workspace unchanged`, ...warnings].join("\n"), true);
        });
      case "compact":
        usage();
        return this.runCommand("compact", options, async () => {
          const result = await runtime.compact(sessionId, options);
          return ephemeral(result.compacted
            ? `Context compacted: ${result.summarizedSteps} step(s) summarized; ${result.retainedSteps} retained; ${result.tokensBefore - result.tokensAfter} estimated tokens freed`
            : "Nothing can be compacted with a meaningful estimated token reduction", result.compacted);
        });
      case "agent": return { kind: "command", result: agentCommand(runtime, this.catalog, sessionId, parseCommandLine(rest)) };
      case "model": return { kind: "command", result: agentCommand(runtime, this.catalog, sessionId, ["main", "model", ...parseCommandLine(rest)]) };
      case "session": {
        const args = parseCommandLine(rest);
        return this.routeThreadCommand(args.length ? `/thread open ${args.join(" ")}` : "/thread sessions", options, sessionId);
      }
      case "thread": return this.routeThreadCommand(input.trim(), options, sessionId);
      case "rewind": {
        const args = parseCommandLine(rest);
        if (args.length > 1) throw new Error("Usage: /rewind [turn-id-or-user-entry-id]");
        if (!args.length) {
          const items = buildRewindItems(this.commandContext(options.signal, sessionId));
          return { kind: "command", result: items.length
            ? viewResult(runtime.fileCheckpoints
              ? "Choose a current-path user message. Rewind restores recorded edit/write changes; bash changes are not tracked. Later changes to recorded files are overwritten."
              : "Choose a current-path user message. Rewind changes the conversation context and leaves workspace files unchanged.", { type: "rewind", items })
            : ephemeral("(no user turns on the current live path)") };
        }
        const candidate = await runtime.rewind(sessionId, args[0]!, options);
        return { kind: "command", result: ephemeral(`Rewound to before ${candidate.turnId}; prior path retained`, true) };
      }
      case "skill": {
        const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
        const name = match?.[1];
        if (!name) {
          const paths = this.skillPaths;
          const content = [
            ...paths.map((directory) => `Skills directory: ${directory}`),
            runtime.skills.length ? `Loaded skills: ${runtime.skills.length}` : "No skills loaded for this application.",
            ...runtime.skills.map((skill) => `- ${skill.name}: ${skill.description} (${skill.filePath})`),
            ...runtime.skillDiagnostics.map((item) => `${item.kind}: ${item.message} (${item.path})`),
          ].join("\n");
          return { kind: "command", result: viewResult(content, {
            type: "command_picker", title: "Skills",
            items: runtime.skills.map((skill) => ({ label: skill.name, description: skill.description, command: `/skill ${skill.name} `, submit: false })),
            emptyText: paths.length ? `No skills loaded. Add skills under ${paths.join(", ")}` : "No skills loaded for this application.",
          }) };
        }
        return { kind: "turn", result: await runtime.invokeSkill(sessionId, name, match?.[2]?.trim() || undefined, options) };
      }
      default:
        throw new Error(`Unknown command: /${command}`);
    }
  }

  static async open(options: ThreadAppOptions): Promise<ThreadApp> {
    const { search, globalMemoryPath, commitAttribution, projectInstructions = true, ...core } = options;
    const threadHome = getThreadHome();
    const skills = core.skills ?? { paths: [skillsDirectory()] };
    const paths = "paths" in skills ? skills.paths.map((directory) => path.resolve(core.rootPath, directory)) : [];
    const tools = core.tools ?? ["read", "view_image", "list", "grep", "write", "edit", "bash", "websearch", "webfetch"];
    const needsAskTool = !core.askPresenter && !tools.some((tool) => typeof tool !== "string" && tool.name === "ask");
    const fileCheckpoints = core.fileCheckpoints ?? true;
    const scheduling = core.scheduling ?? true;
    const runtimeOptions = snapshotRuntimeOptions({
      ...core, tools, skills, fileCheckpoints, scheduling,
      writableExternalDirectories: [...(core.writableExternalDirectories ?? []), threadHome, ...paths],
      protectedWritePaths: [...(core.protectedWritePaths ?? []), path.join(threadHome, "projects"), getAuthFilePath(), `${getAuthFilePath()}.lock`],
      // The runtime appends its concurrency instructions to this Working approach section.
      systemPrompt: [core.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        core.systemPrompt !== undefined ? "# Working approach" : "",
        `Current project working directory: ${path.resolve(core.rootPath)}\nRelative tool paths resolve from this directory unless the tool specifies otherwise.`,
        fileEditingPrompt(fileCheckpoints)].filter(Boolean).join("\n\n"),
      appendSystemPrompt: [core.systemPrompt === undefined ? COMMUNICATION_STYLE_PROMPT : "",
        scheduling ? `# Scheduled tasks

Use schedule_task when the user requests recurring or future work; use list_schedules, update_schedule, pause_schedule, resume_schedule, and delete_schedule to manage it. Use update_schedule to change a task's follow-up prompt and/or time rule without recreating its Session. Prompt-only updates preserve timing; a new schedule recalculates the next follow-up, with every intervals still anchored to task creation. Updates preserve enabled/paused state, pending initialization, and already-running turns. Choose the current Session for follow-ups to this conversation, or a new Session to isolate the work (created once and reused on every wakeup). Creation queues the initial user turn immediately; it runs when its bound Session is idle; other Sessions can run concurrently. Put the full background, scope, and ongoing instructions in initialPrompt, including what to do now. Sessions retain context across wakeups, so keep prompt to a brief wakeup cue without repeating background, rules, or checklists. If initialPrompt is omitted, prompt is also used for initialization. For actions that must wait, give initialPrompt preparation-only instructions. The time rule applies to follow-ups, including one follow-up for at schedules. Schedules persist, but only execute while Thread is running. The user can open the bound Session from /schedule, including while it is running. Do not use bash sleep as a substitute.` : "",
        `# Thread data directory\n\nThread data directory: ${threadHome}\nThe built-in edit and write tools may modify files under this directory. Use absolute paths and keep changes scoped to the user's request. Prefer focused reads and edits to avoid exposing credentials. Project state directories, auth.json, and its lock file are protected from built-in writes. Use the owning service to manage runtime state; config.json, skills, and global memory remain editable.`,
        paths.length ? `Skill installation directories are editable with the built-in edit and write tools, including SKILL.md and companion files. Use absolute paths:\n${paths.join("\n")}` : "",
        formatCommitAttributionPrompt(commitAttribution ?? DEFAULT_COMMIT_ATTRIBUTION),
        core.appendSystemPrompt].filter(Boolean).join("\n\n"),
      ...(search === false ? {} : { search: search ?? {} }),
      ...(globalMemoryPath === false ? {} : { globalMemoryPath: globalMemoryPath ?? path.join(threadHome, GLOBAL_MEMORY_FILE) }),
    });
    if (projectInstructions) {
      const projectText = await loadProjectInstructions(runtimeOptions.rootPath);
      runtimeOptions.sharedInstructions = [runtimeOptions.sharedInstructions, projectText].filter(Boolean).join("\n\n");
    }
    const runtime = await ThreadRuntime.open(runtimeOptions);
    try {
      // Plain mode retains the coding agent's ask contract and its unavailable response.
      if (needsAskTool) runtime.registerTool(createAskTool());
      return new ThreadApp(runtime, core.modelCatalog, paths);
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }

  async loadExtension(specifier: string): Promise<void> {
    this.assertOpen();
    const loading = this.extensionLoading.then(async () => {
      const dispose = await loadExtension(specifier, this.extensionApi, this.runtime.rootPath);
      if (dispose) this.extensionDisposers.push(dispose);
    });
    this.extensionLoading = loading.catch(() => undefined);
    return loading;
  }

  async openSession(sessionId: string, options: { signal?: AbortSignal } = {}) {
    this.assertOpen();
    const session = await this.runtime.openSession(sessionId, options);
    this.selectedSessionId = session.id;
    return session;
  }

  canHandleInput(route: RoutedInput, busy = false): boolean {
    return !this.appClosing && (route.category === "control" || (!busy && !this.runtime.sessionBusy(this.selectedSessionId)
      && ![...this.inputOperations.values()].some((operation) => operation.sessionId === this.selectedSessionId)));
  }

  handleInput(input: string | RoutedInput, options: InputOptions): Promise<InputResult> {
    const route = typeof input === "string" ? parseInput(input) : input;
    if (this.appClosing) return Promise.reject(new Error("Thread application is closed or closing"));
    if (!this.canHandleInput(route)) return Promise.reject(new Error("Wait for the active turn or command to finish"));
    const controller = new AbortController();
    const sessionId = this.selectedSessionId;
    const signal = AbortSignal.any([options.signal, controller.signal]);
    const done = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return this.route(route, { ...options, signal }, sessionId);
    }).finally(() => { this.inputOperations.delete(done); });
    this.inputOperations.set(done, { controller, ...(route.category === "work" ? { sessionId } : {}) });
    void done.catch(() => undefined);
    return done;
  }

  private async routeGoal(action: GoalInputAction, options: InputOptions, sessionId: string): Promise<InputResult> {
    const runtime = this.runtime;
    if (action.type === "run" || action.type === "resume") {
      return { kind: "turn", result: await runtime.runGoal(sessionId, action.type === "run" ? action.objective : undefined, options) };
    }
    if (action.type === "status") {
      const goal = runtime.readGoal(sessionId);
      const content = goal ? formatGoalStatus(goal) : "No goal for this Session. Use /goal <objective> to start one.";
      return { kind: "command", result: viewResult(content, { type: "document", title: "Goal status", content }) };
    }
    const previous = runtime.readGoal(sessionId);
    if (action.type === "pause") await runtime.pauseGoal(sessionId);
    else await runtime.clearGoal(sessionId);
    const message = action.type === "clear" ? previous ? "Goal cleared." : "No goal to clear."
      : !previous ? "No goal to pause." : previous.status === "completed" ? "Goal already completed." : "Goal paused.";
    return { kind: "command", result: ephemeral(message, Boolean(previous)) };
  }

  private async runCommand(name: string, options: InputOptions, execute: () => Promise<CommandResult>): Promise<InputResult> {
    emitCommandEvent(options.onCommandEvent, { type: "command_started", name });
    let ok = false;
    try {
      const result = await execute();
      ok = true;
      return { kind: "command", result };
    } finally {
      emitCommandEvent(options.onCommandEvent, { type: "command_finished", name, ok });
    }
  }

  private commandContext(signal: AbortSignal, sessionId: string) {
    return { rootPath: this.runtime.rootPath, runtime: this.runtime, selectedSessionId: sessionId,
      skills: this.runtime.skills, skillDiagnostics: this.runtime.skillDiagnostics, signal,
      openSession: (id: string) => this.openSession(id, { signal }) };
  }

  private async routeThreadCommand(input: string, options: { signal: AbortSignal }, sessionId: string): Promise<InputResult> {
    const result = await routeThreadCommand(this.commands, input, this.commandContext(options.signal, sessionId));
    if (!result) throw new Error(`Could not route command: ${input}`);
    return { kind: "command", result };
  }

  private assertOpen(): void {
    if (this.appClosing) throw new Error("Thread application is closed or closing");
  }

  close(): Promise<void> {
    if (this.appClosing) return this.appClosing;
    const operations = [...this.inputOperations.entries()];
    this.appClosing = Promise.resolve().then(async () => {
      await Promise.allSettled(operations.map(([done]) => done));
      await this.extensionLoading;
      try {
        await this.runtime.close();
      } finally {
        await Promise.allSettled(this.extensionDisposers.splice(0).map((dispose) => Promise.resolve().then(dispose)));
      }
    });
    for (const [, { controller }] of operations) controller.abort(new DOMException("Thread application closed", "AbortError"));
    return this.appClosing;
  }
}
