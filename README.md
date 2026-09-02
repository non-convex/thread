<div align="center">

# Thread

**A coding-agent runtime with a persistent Session Tree and turn-level workspace rewind.**

[简体中文](./README.zh-CN.md) · [Releases](https://github.com/non-convex/thread/releases) · [Architecture](#architecture)

[![CI](https://github.com/non-convex/thread/actions/workflows/ci.yml/badge.svg)](https://github.com/non-convex/thread/actions/workflows/ci.yml)
[![Bun 1.3+](https://img.shields.io/badge/Bun-1.3%2B-f9f1e1?logo=bun)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

Thread gives every project one durable conversation tree. It remembers the complete path you took, lets you open an independent Session without touching the files, and can restore the workspace to exactly before a selected user turn.

The project directory remains ordinary disk state. Git remains Git. Thread adds a separate, append-only record of agent work and content-addressed workspace checkpoints around it.

```text
Project
├── Current workspace
└── Persistent Session Tree
    ├── Root
    ├── Session A: Turn 1 → Turn 2 → Turn 3
    │                            └────→ Turn 3′ after rewind
    └── Session B: an independent empty context created by /new
```

## See it in action

![Thread welcome screen](docs/assets/thread-welcome.png)

<p align="center"><em>A full-screen TUI that opens directly on the project's persistent Session Tree.</em></p>

![Thread working through a coding task](docs/assets/thread-session.png)

<p align="center"><em>Streaming thinking, tool activity, elapsed time, context usage, model, and thinking level in one view.</em></p>

## Why Thread

| Need | Thread's answer |
| --- | --- |
| Continue project work later | Sessions, turns, messages, tool facts, and live tips are persisted per project. |
| Try a different direction safely | `/rewind` restores the pre-turn workspace and branches the conversation without deleting the old path. |
| Start with a clean context | `/new` creates an empty root Session while leaving project files unchanged. |
| Recall work outside the current path | The agent can search and read turns from other Sessions and abandoned branches. |
| Survive long tasks | Manual and automatic compaction reduce live context without rewriting the Session Tree. |
| Parallelize bounded implementation work | Optional workers handle one or two non-overlapping leaf tasks in the shared workspace. |
| Use different model backends | ChatGPT subscription login and configurable OpenAI- or Anthropic-compatible providers are supported. |

## Design philosophy

The core idea is simple: every project owns one persistent Session Tree. It is the spine of the project's history; every interaction with the agent and every agent execution trace together represent the complete project history. That history is project-level memory. The agent can search and recall it today; a form of project-wide awareness across the whole tree is still planned.

Cross-project global memory and a **Dreamer** mechanism are in active development.

Three principles guide the design:

- **Keep it small.** Avoid over-design and introduce no new entity unless it is necessary.
- **Protect context and cache locality.** Context management and compaction should be deliberate, preserving stable prefixes and prompt-cache hits whenever possible.
- **Earn every token.** Only information that must affect the current step should enter the active context, so the window does not grow prematurely. More selective context admission is still planned.

Thread is not a replacement for version control. It rewinds the managed workspace, not commits, branches, processes, databases, remote services, or other external effects.

## Quick start

### Requirements

- A [standalone release](https://github.com/non-convex/thread/releases), or Bun 1.3+ when running from source
- A configured model provider or a ChatGPT subscription login
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for the built-in code-search tool

Git is optional. Any existing directory can be opened as a project.

### Run a release build

Download the archive for your platform, extract it, and put `thread` (or `thread.exe`) on your `PATH`.

```bash
thread --root /path/to/project
```

An interactive TTY opens the full-screen interface. Piped or redirected use selects plain mode automatically; `--tui plain` forces it.

### Run from source

```bash
git clone https://github.com/non-convex/thread.git
cd thread
bun install
bun run dev --root /path/to/project
```

For the remaining examples, replace `thread` with `bun run dev` when running from source.

### Connect a model

The fastest path for a ChatGPT subscriber is the built-in `openai-codex` OAuth provider:

```bash
thread login openai-codex
thread auth status
thread --root /path/to/project
```

Inside the TUI, run `/model all` to choose an available model. You can also select one at startup:

```bash
thread --root /path/to/project --provider openai-codex --model <model-id>
```

Thread owns this login separately from Codex CLI. Credentials live in `~/.thread/auth.json` (or `$THREAD_HOME/auth.json`) and should be protected like a password. Remove them with `thread logout openai-codex`.

For API keys or a compatible relay, copy [`thread.config.example.json`](./thread.config.example.json) to `~/.thread/config.json`, edit the provider and model, then set the configured `apiKeyEnv` environment variable. Supported custom APIs are:

- `openai-responses`
- `openai-completions`
- `anthropic-messages`

## Core concepts

### One project, one Session Tree

Project identity depends only on the normalized project path. Every project has one virtual Root and any number of top-level Sessions.

- `/new` creates and activates an empty Session. It does not copy messages, call the model, summarize history, or alter files.
- `/session` lists Sessions.
- `/session <id>` resumes a Session at its saved live tip without changing the current workspace.

The model sees only the active Session's current path by default. Historical branches and other Sessions remain searchable project memory through `session_search` and `session_read`; the agent is told to verify current files before relying on stale historical evidence.

### Turns and workspace checkpoints

Each turn records its user message, assistant output, tool calls and results, parent turn, final status, and a workspace-state ID. That workspace state represents the checkpoint before the user turn.

At the end of a turn, Thread captures the next checkpoint. The following send reuses it; only the first turn in a process needs a bootstrap scan. This lets the initial model request overlap checkpoint resolution while preserving a durable pre-turn boundary before any tool side effect.

Interrupted and failed turns are sealed into valid conversation prefixes and remain the live tip. A restart seals any turn that was still marked running. Started tools are never replayed automatically.

### Rewind without erasing history

`/rewind` shows user turns on the active live path. Selecting a turn performs these operations in order:

1. Verify and restore the checkpoint saved before that turn.
2. Move the Session's live tip to the turn's parent.
3. Rebuild model context from the new live path.
4. Keep the selected turn and every later turn in the Session Tree.

Your next message creates a new branch naturally. If the checkpoint is missing or corrupt, rewind fails before the live tip moves.

One subtle boundary matters: a checkpoint comes from the previous completed turn. Manual edits made while Thread was idle after that checkpoint and before the next send are not part of the selected turn's pre-turn state.

### Context compaction

Compaction is another append-only Session Tree entry, not a rewrite of history. It stores a rolling project-state summary, retained complete model steps, and—when the cut falls inside a turn—a separate progress checkpoint.

- `/compact` requests a manual pass.
- Automatic compaction runs at complete model-step boundaries when the context reaches 78% or the provider reports overflow.
- A pass keeps at least the newest five complete steps and expands the retained working set while its roughly 20K-token budget allows.
- Earlier turns remain available to rewind, history, search, and `session_read`.

### Optional implementation workers

Subagents start disabled. Run `/subagent`, choose **On**, then select an explicit worker model. The main agent can delegate one or two independent leaf tasks with non-overlapping write scopes.

Workers edit the same project workspace directly; there is no private clone or apply step. `writeScope` is a coordination boundary rather than a filesystem sandbox. The main agent remains responsible for reviewing current files and running tests, and can request a revision in the same worker context.

Workers belong to the parent turn. Finishing the turn, interrupting it, closing Thread, or restarting cancels unfinished work while preserving any files already written. Use `/rewind` when the whole workspace must be restored. See [the subagent architecture](./docs/subagent-architecture.md) for the full design.

## Commands

### Authentication

| Command | Purpose |
| --- | --- |
| `thread login <provider>` | Start a supported subscription login. |
| `thread logout <provider>` | Remove the provider credential. |
| `thread auth status` | Show subscription authentication status. |

### Interactive commands

| Command | Purpose |
| --- | --- |
| `/new` | Create an empty Session from Root; keep workspace files as-is. |
| `/session [<session-id>]` | List Sessions or resume one at its saved tip. |
| `/rewind [<turn-id-or-user-entry-id>]` | Choose or directly restore a pre-turn checkpoint. |
| `/compact` | Compact the active path's live model context. |
| `/model [all\|list [provider]\|<provider>/<model>]` | Inspect or change the main model. |
| `/subagent [off\|on [all]\|<provider>/<model>]` | Configure implementation workers. |
| `/skill [<name> [extra instruction]]` | List or invoke a loaded skill. |
| `/thread status` | Show project and active Session Tree status. |
| `/thread sessions` | List root Sessions and saved live tips. |
| `/thread open <session-id>` | Resume a Session without changing files. |
| `/thread history` | Browse turns across the whole project tree. |
| `/thread search <query> [<query> ...]` | Search all Sessions and historical paths. |
| `/clear` | Clear the visible transcript only. |
| `/exit` | Exit Thread. |

In the full-screen TUI, `Shift+Tab` cycles supported thinking levels and `Esc` interrupts the active turn.

## Configuration and state

Thread reads `~/.thread/config.json` by default. If it is absent, compatible provider and default-model settings under `~/.pi/agent` are used as a fallback.

Model selection priority is:

```text
--provider/--model or THREAD_PROVIDER/THREAD_MODEL
→ remembered interactive choice in ~/.thread/state.json
→ model in ~/.thread/config.json
```

Useful environment variables:

| Variable | Purpose |
| --- | --- |
| `THREAD_HOME` | Override the state directory (default `~/.thread`). |
| `THREAD_CONFIG` | Use a different configuration file. |
| `THREAD_PROVIDER` | Select the main provider; use with `THREAD_MODEL`. |
| `THREAD_MODEL` | Select the main model; use with `THREAD_PROVIDER`. |

Thinking level, main-model selection, subagent on/off state, and worker-model selection are remembered in `~/.thread/state.json`. Skills are loaded once at startup. Extensions can register tools, Session Tree commands, and runtime hooks through the exported API.

## Persistence and safety boundary

Project state is stored outside the workspace under `~/.thread/projects/<project-id>`:

```text
project.json
session-tree/
  tree.json
  events.jsonl
workspace-states/
  states/
  blobs/
agent-tasks/
  events.jsonl
```

Session Tree and Agent Task records are independent append-only JSONL streams. Workspace states are content-addressed manifests and blobs and include empty directories.

Checkpoints do not blindly follow `.gitignore`, but they exclude Thread metadata and common generated-directory names at every depth, including `.git`, `.thread`, `node_modules`, `dist`, `build`, `coverage`, `target`, virtual environments, and common framework caches. Embedders can add project-relative exclusions with `ThreadAppOptions.workspaceExcludedPaths`.

Paths outside the project, excluded directories, processes, databases, network effects, and other external state are never restored by `/rewind`.

The loader accepts only the current `thread-project-v1`, `thread-session-tree-v1`, `thread-workspace-state-v2`, and `thread-agent-task-v2` formats. Old data is not silently migrated or partially interpreted.

## Execution model

Tool scheduling is effect- and resource-aware:

- Read effects may start as soon as a complete streamed tool call and its start fact are durable.
- Write, process, and interactive effects wait for the complete assistant response to be durable.
- Independent resources can run concurrently; overlapping read/write resources retain source order.
- Completion events follow actual completion order, while tool-result messages are committed in assistant source order before the next model request.

The TUI can therefore stay responsive and expose work early without weakening the durability boundary around side effects.

## Architecture

```text
src/project/          project identity and lifecycle
src/session-tree/     Sessions, Turns, Entries, paths, history, and search
src/workspace-state/  checkpoint capture, verification, restore, and GC
src/context/          live-path projection, budgets, and compaction
src/agent/            model steps, journaling, scheduling, and turn runtime
src/agent-task/       shared-workspace worker lifecycle and task journal
src/app/              runtime composition, input routing, and use cases
src/commands/         Session Tree command interface
src/tools/            built-in agent tools and execution policies
src/ui/               plain and full-screen terminal interfaces
```

Thread also exports its runtime, stores, model catalog, tools, commands, skills loader, extension API, and UI types for embedding. See [`src/index.ts`](./src/index.ts) for the public surface.

Further reading:

- [Subagent architecture](./docs/subagent-architecture.md)
- [Designing grep output for an agent's context window](./docs/grep.md) (Chinese)

## Development

```bash
bun run check
bun test test --timeout 30000
bun run build
```

CI runs type-checking, tests, a production build, and a CLI smoke test. Tagged releases compile standalone Windows, Linux, and macOS binaries for x64 and ARM64.

## License

[MIT](./LICENSE)
