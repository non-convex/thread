# thread

`thread` is a coding-agent runtime with one persistent **Session Tree** per project and a safe, turn-level `/rewind`.

The project directory is ordinary disk state. Conversation history is an append-only tree. Before every user turn, Thread captures the managed workspace so that the exact pre-turn state can be recovered later.

```text
Project
├── Current workspace
└── Persistent Session Tree
    ├── Root
    ├── Session A: Turn 1 → Turn 2 → Turn 3
    │                            └────→ Turn 3′ after rewind
    └── Session B: an independent empty context created by /new
```

Thread does not implement its own general-purpose version control. Project Git, if present, is just another external tool available to the agent.

## Requirements

- Bun 1.3 or newer
- A model configured through `~/.thread/config.json`, the compatible pi fallback, `--provider` and `--model`, or a ChatGPT subscription login

Git is not required. Any existing directory can be opened as a project.

```bash
bun install
bun run dev --root /path/to/project
```

An interactive TTY opens the full-screen terminal. Non-TTY use selects plain mode automatically. Use `--tui plain` to force it.

### ChatGPT subscription

Thread can use Codex access included with a ChatGPT subscription through the built-in `openai-codex` OAuth provider. The login is owned by Thread and stored separately from Codex CLI credentials:

```bash
thread login openai-codex
thread auth status
thread --provider openai-codex --model gpt-5.6-terra
```

After the first successful login, `openai-codex` models appear in the normal `/model` picker and OAuth tokens refresh automatically. Credentials are stored in `~/.thread/auth.json` (or `$THREAD_HOME/auth.json`); treat that file like a password. To remove them:

```bash
thread logout openai-codex
```

## Core behavior

### Sessions

One project owns one persistent Session Tree with a virtual Root. Each top-level Session is created directly from that Root.

`/new` creates an empty Session, activates it, and leaves project files untouched. It does not copy messages, generate a summary, call the model, or restore files. `/session` lists Sessions; `/session <id>` resumes one at its saved live tip without changing the workspace.

The model automatically sees only the active Session's current path. Other Sessions and abandoned paths remain project memory and can be recalled through `session_search` and `session_read`.

### Turns and workspace states

A turn contains its user message, assistant messages, tool execution facts, tool results, final status, parent turn, and a workspace-state ID. That ID is the last saved checkpoint: the previous turn's end-of-turn snapshot, or a one-time bootstrap scan on the first turn of a process. The order is fixed:

```text
show the user message and create a runtime-only planned turn
→ reuse the last checkpoint (scan only if none exists yet) and start the first model request concurrently
→ bind that workspace-state ID and planned identity into a formal running turn
→ persist Session Tree records in the background
→ before any tool side effect, durably flush the workspace state and tool-start fact
→ durably finish the turn, scan a new checkpoint, and advance the Session live tip
```

An interrupted or failed turn is sealed into a valid conversation prefix (placeholder assistant and aborted tool results as needed) and becomes the Session live tip, so the next prompt continues from that point. At startup, any turn left running is sealed the same way; tools are never automatically repeated.

Tool scheduling is effect- and resource-aware. Read effects may start as soon as a complete streamed call and its tool-start fact are durable. Write, process, and interactive effects wait for the complete assistant response to be durable. Independent resources run concurrently; overlapping read/write resources and explicitly sequential tools retain assistant source order. Completion events follow real completion order, while tool-result messages are committed in assistant source order before the next model request.

The TUI projects the submitted user message immediately. A planned turn is runtime-only and exists just long enough to let the first model request overlap checkpoint resolution; it becomes a factual Session Tree turn once the workspace-state ID is known. Session Tree records then enter the in-memory projection synchronously and are written by one ordered background queue. Tool execution and final turn completion are durability barriers. The end-of-turn scan is the saved checkpoint for the next send; blob persist may finish in the background.

Workspace states are content-addressed manifests and blobs stored under `~/.thread/projects/<project-id>/workspace-states`. They include empty directories and do not otherwise follow `.gitignore`, but common dependency, build-output, and cache directories are excluded by basename at every depth: `.build`, `.cache`, `.dart_tool`, `.gradle`, `.mypy_cache`, `.next`, `.nox`, `.nuxt`, `.nx`, `.output`, `.parcel-cache`, `.pytest_cache`, `.ruff_cache`, `.svelte-kit`, `.tox`, `.turbo`, `.venv`, `__pycache__`, `bower_components`, `build`, `coverage`, `dist`, `node_modules`, `out`, `target`, and `venv`. `.git`, `.thread`, Thread's own state path, paths outside the project, processes, databases, network effects, and other external state are also excluded. Additional project-relative exclusions can be supplied through `ThreadAppOptions.workspaceExcludedPaths`.

### Rewind

`/rewind` lists only user turns on the active live path. Selecting a turn means “restore the checkpoint saved before this turn”: the previous turn's end-of-turn snapshot, not edits made in the idle gap after that snapshot. The first turn in a process bootstraps from a scan at send time.

1. Verify and restore that turn's workspace state.
2. Move the active Session's live tip to the selected turn's parent.
3. Rebuild live context from the new path; off-path compaction entries stop applying naturally.
4. Keep the selected turn and all later turns in the Session Tree.

The next user message naturally creates a new child path. A missing or corrupt workspace state causes rewind to fail before the live tip moves.

### Context compaction

Compaction is an append-only Session Tree entry. It stores a summary, a verbatim suffix of complete turns, the pre-compaction token estimate, and the trigger reason. `/compact` appends one to the current live tip; automatic compaction appends the same entry type at 78% of the model window and after a provider reports overflow.

Before generating a summary, Thread estimates the actual system/tool overhead and reserves 4K tokens for the summary. It then retains the largest suffix of whole turns that keeps `system + summary + retained turns` near 20K tokens, while always retaining at least the newest two turns. Every model request rebuilds live context from the current path's entries. If the path contains compactions, only the newest one is projected as `summary + retained turns`, followed by messages appended after that entry. Earlier entries are not deleted or rewritten, so rewind, branching, history, and search continue to use the complete Session Tree.

### Implementation workers

Thread can delegate one or two independent leaf implementation tasks to `implementation-worker` agents after subagents are explicitly enabled with `/subagent`. Selecting `On` opens the worker model picker; selecting `Off` removes delegation tools and their system-prompt instructions from the main agent. Each worker receives only its task specification and a private workspace materialized from one shared base state. It uses only `read`, `list`, `grep`, `write`, `edit`, and `bash`; child traces never enter the parent Session context.

Workers produce mechanical `thread-change-set-v1` manifests. The main agent must inspect the complete diff, may continue the same worker with concrete revision feedback, and applies an approved candidate through conservative three-way conflict checking. Workers never edit the current project directly. Apply is serialized and transactional, with a durable recovery record and rollback on failure. The parent turn owns every task: interruption or turn completion cancels or discards anything not already applied or terminal. `/rewind` restores the single pre-turn workspace state, so it also removes worker changes applied during that turn.

Task events and child traces are stored separately from the Session Tree. The TUI anchors expandable task cards at the originating `delegate_tasks` call; the parent context receives only compact task-tool results.

## Commands

Top-level authentication commands:

```text
thread login <provider>
thread logout <provider>
thread auth status
```

Interactive commands:

```text
/new
/session [<session-id>]
/rewind [<turn-id-or-user-entry-id>]
/compact
/model [all|list [provider]|<provider>/<model>]
/subagent [off|on [all]|<provider>/<model>]
/skill [<name> [extra instruction]]
/clear
/exit

/thread status
/thread sessions
/thread open <session-id>
/thread history
/thread search <query> [<query> ...]
```

Removed version-management commands are intentionally not recognized.

## Project memory tools

- `session_search` searches every turn across all Sessions and historical paths. Results include the Session, turn, timestamp, status, and relationship to the current path.
- `session_read` reads one matching turn or a bounded contiguous path around it. Narrative is returned by default; thinking, tool calls, and tool results are opt-in.

Historical evidence may be stale relative to the current workspace, so the agent is instructed to verify files when correctness depends on them.

## Persistence and compatibility

Project identity depends only on the normalized project path, never on a repository or worktree. New-format state lives under `~/.thread/projects/<project-id>` (or `$THREAD_HOME/projects/<project-id>`):

```text
project.json
session-tree/
  tree.json
  events.jsonl
workspace-states/
  states/
  blobs/
  apply-recovery/
agent-tasks/
  events.jsonl
  changesets/
  workspaces/
```

The Session Tree and Agent Task logs are independent append-only JSONL streams. ChangeSet manifests reference the shared content-addressed workspace blob store. The loader accepts only the current `thread-project-v1`, `thread-session-tree-v1`, `thread-workspace-state-v1`, `thread-agent-task-v1`, and `thread-change-set-v1` formats. Old data is not read, migrated, upgraded, or partially interpreted.

## Configuration

The unified Thread configuration is `~/.thread/config.json`. See `thread.config.example.json`. `THREAD_HOME`, `THREAD_CONFIG`, `THREAD_PROVIDER`, and `THREAD_MODEL` are supported. Interactive main-model, thinking-level, subagent on/off, and worker-model choices are remembered in `~/.thread/state.json`; command-line selection can still override the main model.

Subagents start `Off`. Run `/subagent`, choose `On`, then choose an explicit worker model; that selection is never inferred from the main model. The optional `agents.implementation-worker` config supplies the initial worker-model highlight and execution limits, but does not enable delegation by itself. An unavailable remembered worker model produces a non-fatal startup diagnostic and leaves task-management tools unregistered. `/model` changes only the main model.

Skills are loaded once at startup and become part of the stable system-prompt prefix. Extensions can register tools, Session Tree commands, and runtime hooks through the exported API.

## Development

```bash
bun run check
bun test test --timeout 30000
bun run build
```

The main boundaries are:

```text
src/project/          project identity and lifecycle
src/session-tree/     persistent Sessions, Turns, Entries, paths, history, search
src/workspace-state/  state store, capture, materialization, diff and transactional apply
src/context/          live-path projection, budget, and compaction entries
src/agent/            shared model-step, journal, tool scheduling, and parent-turn runtime
src/agent-task/       profiles, task journal/projection, isolated workers, review and apply
src/app/              façade, input routing, main-model state, runtime composition, use cases
src/commands/         command interface
src/ui/               plain and full-screen interfaces
```

## License

MIT. See `LICENSE`.
