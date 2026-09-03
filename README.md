<div align="center">

# Thread

**A coding-agent runtime built around two layers of persistent memory.**

[简体中文](./README.zh-CN.md) · [Releases](https://github.com/non-convex/thread/releases) · [Development](#development)

[![CI](https://github.com/non-convex/thread/actions/workflows/ci.yml/badge.svg)](https://github.com/non-convex/thread/actions/workflows/ci.yml)
[![Bun 1.3+](https://img.shields.io/badge/Bun-1.3%2B-f9f1e1?logo=bun)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

## Memory model and design

Thread defines two memory scopes:

1. **Project memory — available now.** Every project owns one persistent Session Tree. All interaction with the agent and every agent execution trace together form the project's complete history; that history is its memory. The agent can search and recall it today. Project-wide awareness across the whole tree is planned.
2. **Global memory — in development.** Memory will extend across projects, with a **Dreamer** mechanism that actively organizes and evolves it.

Three constraints shape the implementation:

1. **Keep it small.** Avoid over-design; introduce no entity unless it is necessary.
2. **Protect cache locality.** Design context management and compaction carefully, preserving stable prefixes and prompt-cache hits whenever possible.
3. **Admit only what is needed.** Information should enter active context only when it must affect the current step, preventing premature window growth. Finer-grained context admission is planned.

## Interface

![Thread welcome screen](docs/assets/thread-welcome.png)

<p align="center"><em>Open a project directly into its persistent Session Tree.</em></p>

![Thread working through a coding task](docs/assets/thread-session.png)

<p align="center"><em>Thinking, tool activity, elapsed time, context usage, model, and thinking level in one view.</em></p>

## Quick start

### Requirements

- A [standalone release](https://github.com/non-convex/thread/releases), or Bun 1.3+ when running from source
- A model provider or ChatGPT subscription login
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) for the built-in code-search tool

Git is optional. Thread can open any existing directory as a project.

### Run a release build

Download the archive for your platform, extract it, and put `thread` (or `thread.exe`) on your `PATH`:

```bash
thread --root /path/to/project
```

Use `--tui plain` to force plain mode.

### Run from source

```bash
git clone https://github.com/non-convex/thread.git
cd thread
bun install
bun run dev --root /path/to/project
```

When running from source, replace the `thread` executable in later examples with `bun run dev`.

### Connect a model

ChatGPT subscribers can use the built-in `openai-codex` OAuth provider:

```bash
thread login openai-codex
thread auth status
thread --root /path/to/project
```

Run `/model all` inside the TUI to choose an available model, or select one at startup:

```bash
thread --root /path/to/project --provider openai-codex --model <model-id>
```

Thread stores this login separately from Codex CLI in `~/.thread/auth.json` (or `$THREAD_HOME/auth.json`). Treat it like a password. Remove it with `thread logout openai-codex`.

For an API key or compatible relay, copy [`thread.config.example.json`](./thread.config.example.json) to `~/.thread/config.json`, edit the provider and model, and set the environment variable named by `apiKeyEnv`. Custom providers can use `openai-responses`, `openai-completions`, or `anthropic-messages`.

## How it works

### Sessions are paths through one history

A project owns one virtual Root and any number of top-level Sessions. A Session is not a copy of the workspace; it is an independent path through project history.

```text
Project
├── Current workspace
└── Persistent Session Tree
    ├── Session A: Turn 1 → Turn 2 → Turn 3
    │                            └────→ Turn 3′ after rewind
    └── Session B: independent context created by /new
```

- `/new` creates and activates an empty Session without copying messages, calling the model, summarizing history, or changing files.
- `/session` lists Sessions.
- `/session <id>` resumes one at its saved live tip, again without changing files.

The model normally sees only the active Session's live path. Everything else remains in project memory and can be recalled when needed.

### Turns connect interaction, execution, and workspace state

Each turn records the user message, assistant output, tool execution facts and results, parent turn, final status, and a workspace-state ID. The workspace state is the checkpoint before that user turn.

Thread captures the next checkpoint when a turn ends and reuses it for the next send. The first turn in a process performs a bootstrap scan. Interrupted and failed turns are sealed into valid conversation prefixes and remain the live tip, so the next request can continue from factual history.

Worker execution traces are kept in the same project's Agent Task journal rather than injected into the parent context. The parent receives compact task results and reviews the shared workspace directly.

### Rewind creates a branch

`/rewind` lists user turns on the active live path. Selecting one:

1. verifies and restores its pre-turn workspace checkpoint;
2. moves the Session live tip to the turn's parent;
3. rebuilds context from that path; and
4. keeps the selected turn and all later turns in history.

The next message creates a new child path. Missing or corrupt state fails before the live tip moves.

A checkpoint comes from the previous completed turn. Manual edits made after that checkpoint while Thread is idle are not part of the next turn's pre-turn state.

### Search and recall

`session_search` searches every Session and historical branch. `session_read` retrieves one matching turn or a bounded path around it. Recalled information can be stale, so the agent is instructed to check current files whenever correctness depends on it.

## Context policy

- Normal requests contain the active live path; off-path history enters only through explicit recall.
- Skills are loaded once into a stable system-prompt prefix.
- Compaction happens only at complete model-step boundaries and is stored as another append-only tree entry.
- Compaction preserves stable prefixes where possible and proceeds only when its estimated context benefit is material.

`/compact` requests a manual pass. Automatic compaction runs when context reaches 78% or a provider reports overflow. A pass keeps at least the newest five complete steps and expands the retained working set while its roughly 20K-token budget allows. Earlier history remains available to rewind, search, and recall.

## Implementation workers

Subagents start disabled. Run `/subagent`, choose **On**, and select an explicit worker model. The main agent can then delegate one or two independent leaf tasks with non-overlapping `writeScope` values.

Workers edit the current project directly. There is no private clone or apply step, and `writeScope` is a coordination boundary rather than a filesystem sandbox. The main agent reviews the files and tests; completed workers can receive revision feedback in the same context.

Workers belong to their parent turn. Finishing or interrupting the turn, closing Thread, or restarting cancels unfinished tasks while preserving files already written. Use `/rewind` to restore the whole workspace. See [the subagent architecture](./docs/subagent-architecture.md) for details.

## Commands

| Command | Purpose |
| --- | --- |
| `thread login <provider>` | Start a supported subscription login. |
| `thread logout <provider>` | Remove a provider credential. |
| `thread auth status` | Show subscription authentication status. |
| `/new` | Create an empty Session; keep workspace files unchanged. |
| `/session [<session-id>]` | List Sessions or resume one. |
| `/rewind [<turn-id-or-user-entry-id>]` | Choose or directly restore a pre-turn checkpoint. |
| `/compact` | Compact the active live context. |
| `/model [all\|list [provider]\|<provider>/<model>]` | Inspect or change the main model. |
| `/subagent [off\|on [all]\|<provider>/<model>]` | Configure implementation workers. |
| `/skill [<name> [extra instruction]]` | List or invoke a loaded skill. |
| `/thread status` | Show project and active-tree status. |
| `/thread sessions` | List Sessions and saved live tips. |
| `/thread open <session-id>` | Resume a Session without changing files. |
| `/thread history` | Browse turns across the whole tree. |
| `/thread search <query> [<query> ...]` | Search all Sessions and branches. |
| `/clear` | Clear the visible transcript. |
| `/exit` | Exit Thread. |

In the full-screen TUI, `Shift+Tab` cycles supported thinking levels and `Esc` interrupts the active turn.

## Configuration and storage

Thread reads `~/.thread/config.json` by default and falls back to compatible settings under `~/.pi/agent` when that file is absent. Main-model selection priority is:

```text
--provider/--model or THREAD_PROVIDER/THREAD_MODEL
→ remembered choice in ~/.thread/state.json
→ model in ~/.thread/config.json
```

`THREAD_HOME` changes the state directory and `THREAD_CONFIG` selects another config file. Main-model, thinking-level, subagent, and worker-model choices are remembered in `~/.thread/state.json`.

Project state lives outside the workspace:

```text
~/.thread/projects/<project-id>/
├── project.json
├── session-tree/{tree.json,events.jsonl}
├── workspace-states/{states,blobs}
└── agent-tasks/events.jsonl
```

Session Tree and Agent Task records are independent append-only logs. Workspace states are content-addressed. Checkpoints exclude Thread metadata and common generated directories such as `.git`, `.thread`, `node_modules`, `dist`, `build`, `coverage`, `target`, virtual environments, and framework caches.

`/rewind` never restores excluded paths, paths outside the project, processes, databases, network effects, or other external state. Thread does not implement general-purpose version control.

## Development

```bash
bun run check
bun test test --timeout 30000
bun run build
```

Main code boundaries:

```text
src/session-tree/     persistent project history, paths, search, and recall
src/workspace-state/  checkpoint capture, verification, restore, and GC
src/context/          live-path projection and compaction
src/agent/            model steps, tool scheduling, journals, and turns
src/agent-task/       shared-workspace worker lifecycle and task journal
src/app/              runtime composition and input routing
src/tools/            built-in agent tools and execution policies
src/ui/               plain and full-screen terminal interfaces
```

Thread also exports its runtime, stores, model catalog, tools, commands, skills loader, extension API, and UI types for embedding. See [`src/index.ts`](./src/index.ts).

Further reading:

- [Subagent architecture](./docs/subagent-architecture.md)
- [Designing grep output for an agent's context window](./docs/grep.md) (Chinese)

## License

[MIT](./LICENSE)
