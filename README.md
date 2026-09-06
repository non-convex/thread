<div align="center">

# Thread

**One project, one Session Tree. Your interactions with the agent are the project's memory.**

[简体中文](./README.zh-CN.md) · [Releases](https://github.com/non-convex/thread/releases) · [Development](#development)

[![CI](https://github.com/non-convex/thread/actions/workflows/ci.yml/badge.svg)](https://github.com/non-convex/thread/actions/workflows/ci.yml)
[![Bun 1.3.14+](https://img.shields.io/badge/Bun-1.3.14%2B-f9f1e1?logo=bun)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

Thread is a coding-agent runtime built around project memory. How a requirement emerged, why an approach was chosen, what execution revealed, and how the user corrected the direction—all of these interactions persist in one Session Tree. Together, they form the project's memory, ready to be searched, recalled, and continued as work progresses.

Thread follows two design principles: **add features with restraint; manage context with care.**

## Interaction is project memory

Each project has one persistent Session Tree. Each round of interaction between the user and agent forms a turn; successive turns form a path, and continuing after a rewind creates a branch. A project can have multiple Sessions, all within the same tree and all available to project-wide search and recall.

```text
Project
├── Workspace
└── Session Tree
    ├── Session A
    │   └── Turn 1
    │       └── Turn 2
    │           ├── Turn 3 → Turn 4
    │           └── Turn 3′ → ...  (after rewind)
    └── Session B
        └── Turn 1 → ...          (created by /new)
```

**A memory's position in the tree preserves the clues needed to understand it.**

- **Context comes with the memory.** A decision belongs to a particular interaction, follows earlier discussion, and sits on a specific branch. Recall can return to the original conversation and read nearby turns along that path.
- **Its basis can be examined.** The user's request, the agent's response, and the turn's tool calls and results are recorded together. They show the conditions and evidence behind a conclusion.
- **Revisions have a history.** Later additions, corrections, and reversals become new interactions. Trying again after a rewind creates a branch while preserving the previous path. Memory evolves with the project, retaining earlier judgments and the process that changed them.

For example, an early constraint leads the project to choose approach A. When that constraint changes, the user and agent discuss it and adopt B. Both discussions remain in project memory. Asked later why B was chosen, the agent can search for those turns and return to the discussion to understand how the choice evolved.

Position provides provenance and context. Deciding whether a historical conclusion still applies requires reading relevant revisions and, when needed, checking the current files.

## Two design principles

### 1. Add features with restraint

Thread exercises restraint when adding features and capabilities. An addition earns its place only when it is clearly useful in helping users and agents get project work done. Keep the product small and focus effort on capabilities that bring real value.

### 2. Manage context with care

Project memory keeps growing; each model request is organized around the work at hand. Thread builds model-visible context from the active Session's current path, or live path, recalls other history as needed, and compacts earlier content when necessary.

- **Read on demand.** Search returns relevant turn locations and snippets first. The agent then reads the original conversation and necessary context, explicitly expanding execution details when useful.
- **Keep the prefix stable.** Skills load at startup into a stable system-prompt prefix, and global memory uses a fixed per-Session snapshot to help preserve prompt-cache hits.
- **Compact carefully.** Compaction happens at complete model-step boundaries, preserves recent complete steps, and proceeds only when the estimated context reduction is material.
- **Preserve original history.** Compaction shapes later requests; the original interactions remain in the tree for search, recall, and rewind.
- **Bound execution detail in context.** Workers keep their full execution traces in a separate journal. The main agent receives compact task results and inspects the workspace directly.

`/compact` requests a manual pass. Automatic compaction runs when context reaches 78% or a provider reports overflow. A pass keeps at least the newest five complete steps and retains more recent content when the roughly 20K-token target budget allows.

Live-path context, on-demand recall, and compaction are implemented. Model awareness of the whole tree and finer-grained control over what enters context remain planned.

## Interface

![Thread welcome screen](docs/assets/thread-welcome.png)

<p align="center"><em>Open a project directly into its persistent Session Tree.</em></p>

![Thread working through a coding task](docs/assets/thread-session.png)

<p align="center"><em>Thinking, tool activity, elapsed time, context usage, model, and thinking level in one view.</em></p>

## Quick start

### Requirements

- A [standalone release](https://github.com/non-convex/thread/releases), or Bun 1.3.14+ when running from source
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

Built-in model metadata can be overridden in `~/.thread/config.json` without replacing its provider or authentication. For example, `"modelOverrides": { "openai-codex/gpt-5.6-sol": { "contextWindow": 500000 } }` changes Thread's local context budgeting, display, and compaction threshold. It cannot raise a limit enforced by the provider. When Thread falls back to `~/.pi/agent/models.json`, it also reads pi's nested `providers.<provider>.modelOverrides` format.

For an API key or compatible relay, copy [`thread.config.example.json`](./thread.config.example.json) to `~/.thread/config.json`, edit the provider and model, and set the environment variable named by `apiKeyEnv`. Custom providers can use `openai-responses`, `openai-completions`, or `anthropic-messages`.

## Working within the tree

### Start and resume

Each Session saves the end of its current path, or live tip. All Sessions use the same project workspace.

- `/new` creates and activates an empty Session with independent context. Project history remains available for recall.
- `/session` lists Sessions.
- `/session <id>` resumes the selected Session at its saved live tip.

Creating and switching Sessions leave workspace files unchanged. `/new` does not copy messages, call the model, or summarize history.

### Turns connect interaction, execution, and workspace state

Each turn records the user message, assistant output, tool execution facts and results, parent turn, final status, and a workspace-state ID. The workspace state is the checkpoint before that user turn.

Thread captures the next checkpoint when a turn ends and reuses it for the next send. The first turn in a process performs a bootstrap scan. Interrupted and failed turns are sealed into valid conversation prefixes and remain the live tip, so the next request can continue from factual history.

### Rewind creates a branch

`/rewind` lists user turns on the active live path. Selecting one:

1. verifies and restores its pre-turn workspace checkpoint;
2. moves the Session live tip to the turn's parent;
3. rebuilds context from that path; and
4. keeps the selected turn and all later turns in history.

The next message creates a new child path. Missing or corrupt state fails before the live tip moves.

A checkpoint comes from the previous completed turn. Manual edits made after that checkpoint while Thread is idle are not part of the next turn's pre-turn state.

### Search and recall

The agent uses two tools to access project memory:

| Tool | Purpose |
| --- | --- |
| `session_search` | Search ended turns across all Sessions and historical branches, returning sources, path status, and relevant snippets. |
| `session_read` | Read an original turn, optionally including nearby turns, tool calls, tool results, or saved thinking. |

Search combines Chinese-aware BM25, exact identifier matching, and local semantic retrieval. Results distinguish the current path, historical branches of the current Session, and other Sessions, helping the agent interpret their relationship to current work.

Nearby turns are read along a tree path. For a branch that is no longer on its Session's saved path, the current reader expands only the target's ancestors. Long content is paginated, and execution details are omitted by default and expanded on request.

The first search downloads a pinned multilingual-e5-small Q8 model and tokenizer (about 135 MB) into `${THREAD_HOME}/models`. Model preparation and vector indexing run in the background; keyword search works immediately. Later retrieval can run offline. Set `HF_ENDPOINT` for a download mirror, or configure `"search": { "semantic": false }` to disable semantic retrieval and model downloads. Indexing and retrieval computation run locally.

Tool logs and saved thinking are searchable by keyword; only user and assistant narrative is embedded. Recall tool calls and results, compaction summaries, and copied content are excluded from indexing. Original evidence remains readable through `session_read`. Search reports indexing coverage and any fallback.

Users can also run `/thread search "why was this designed this way"` directly. See [how project memory search works](./docs/session-recall.md) and [Session tool parameters and examples](./docs/session-tools.md).

## Cross-project memory and optional agents

Stable information that applies across projects lives in one Markdown file, `${THREAD_HOME}/.THREAD.md`. Main maintains it only when the user's current message explicitly provides stable information useful across projects. A fixed snapshot enters the system prompt and counts toward the context budget; the file itself stays outside the Session Tree, search, rewind, and compaction. `/new` reads the latest contents for the new Session, and restarting refreshes all Session snapshots.

`/agent` is the common entry point for model selection and agent settings. Thread has three built-in profiles: `main`, `implementation-worker`, and `dreamer`. Both secondary agents start disabled and are enabled by explicitly selecting a model:

| Agent | Enable with | Role |
| --- | --- | --- |
| `implementation-worker` | `/agent implementation-worker model <provider>/<model>` | Complete one or two independent leaf tasks with non-overlapping write scopes in the shared workspace. The main agent reviews files and tests and can request revisions. |
| `dreamer` | `/agent dreamer model <provider>/<model>` | Review interactions and execution traces in the background for well-supported implicit user patterns and lessons useful across projects, maintaining global memory. |

Workers edit the current workspace directly, with `writeScope` serving as a coordination boundary. Tasks belong to their parent turn. Finishing or interrupting the turn, closing Thread, or restarting cancels unfinished tasks while preserving files already written. Use `/rewind` to restore the whole workspace. See [the subagent architecture](./docs/subagent-architecture.md).

Dreamer starts after ten ended turns and ten continuous minutes of Main being idle. It stays silent and runs for at most five minutes; most reviews should leave memory unchanged. See [global memory and Dreamer architecture](./docs/global-memory-architecture.md).

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
| `/model [all\|list [provider]\|<provider>/<model>]` | Inspect or select the main model. |
| `/agent` | Choose an agent, then configure it. |
| `/agent <id> [on\|off]` | Open settings or toggle a secondary agent. |
| `/agent <id> model [all\|list [provider]\|<provider>/<model>]` | Inspect or select an agent model. |
| `/skill [<name> [extra instruction]]` | List or invoke a loaded skill. |
| `/thread status` | Show project and active-tree status. |
| `/thread sessions` | List Sessions and saved live tips. |
| `/thread open <session-id>` | Resume a Session without changing files. |
| `/thread history` | Browse turns across the whole tree. |
| `/thread search <query> [<query> ...]` | Search all Sessions and branches. |
| `/clear` | Clear the visible transcript. |
| `/exit` | Exit Thread. |

In the full-screen TUI, `Shift+Tab` cycles supported thinking levels, `Ctrl+V` (or `Alt+V` when the terminal intercepts Ctrl+V) attaches a clipboard image for vision models, and `Esc` interrupts the active turn.

## Configuration and storage

Thread reads `~/.thread/config.json` by default and falls back to compatible settings under `~/.pi/agent` when that file is absent. Main-model selection priority is:

```text
--provider/--model or THREAD_PROVIDER/THREAD_MODEL
→ remembered choice in ~/.thread/state.json
→ model in ~/.thread/config.json
```

`THREAD_HOME` changes the state directory and `THREAD_CONFIG` selects another config file. Main-model, thinking-level, and secondary-agent choices are remembered in `~/.thread/state.json`.

Git commits created or amended by Thread include `Co-authored-by: Thread <324980244+thread-agent@users.noreply.github.com>` by default. This keeps the user's configured Git author intact while linking Thread's GitHub account as a co-author. To disable or replace the trailer, set `attribution.commit` in `~/.thread/config.json`; an empty string disables it.

Project state lives outside the workspace:

```text
~/.thread/projects/<project-id>/
├── project.json
├── session-tree/{tree.json,events.jsonl}
├── workspace-states/{states,blobs}
├── session-search/
└── agent-tasks/events.jsonl
```

Session Tree and Agent Task records are independent append-only logs. Workspace states are content-addressed. `session-search` holds derived indexes that can be rebuilt from the Session Tree. Checkpoints exclude Thread metadata and common generated directories such as `.git`, `.thread`, `node_modules`, `dist`, `build`, `coverage`, `target`, virtual environments, and framework caches.

`/rewind` never restores excluded paths, paths outside the project, processes, databases, network effects, or other external state. Thread does not implement general-purpose version control.

## Development

```bash
bun run check
bun test test --timeout 30000
bun run build
```

Main code boundaries:

```text
src/session-tree/     persistent project history and paths
src/session-recall/   history retrieval, derived indexes, and local embeddings
src/workspace-state/  checkpoint capture, verification, restore, and GC
src/context/          live-path projection and compaction
src/agent/            model steps, tool scheduling, journals, and turns
src/agent-task/       shared-workspace worker lifecycle and task journal
src/dreamer/          background global-memory curation and scheduling
src/app/              runtime composition and input routing
src/tools/            built-in agent tools and execution policies
src/ui/               plain and full-screen terminal interfaces
```

Thread also exports its runtime, stores, model catalog, tools, commands, skills loader, extension API, and UI types for embedding. See [`src/index.ts`](./src/index.ts).

Further reading:

- [Subagent architecture](./docs/subagent-architecture.md)
- [Session recall architecture](./docs/session-recall.md)
- [Session tool parameters and examples](./docs/session-tools.md)
- [Global memory and Dreamer architecture](./docs/global-memory-architecture.md)
- [Full-screen TUI](./docs/tui.md) (Chinese)
- [Pasting clipboard images into the TUI](./docs/tui-image-paste.md) (Chinese)
- [Designing grep output for an agent's context window](./docs/grep.md) (Chinese)

## License

[MIT](./LICENSE)
