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
- A model configured through `~/.thread/config.json`, the compatible pi fallback, or `--provider` and `--model`

Git is not required. Any existing directory can be opened as a project.

```bash
bun install
bun run dev --root /path/to/project
```

An interactive TTY opens the full-screen terminal. Non-TTY use selects plain mode automatically. Use `--tui plain` to force it.

## Core behavior

### Sessions

One project owns one persistent Session Tree with a virtual Root. Each top-level Session is created directly from that Root.

`/new` creates an empty Session, activates it, and leaves project files untouched. It does not copy messages, generate a summary, call the model, or restore files. `/session` lists Sessions; `/session <id>` resumes one at its saved live tip without changing the workspace.

The model automatically sees only the active Session's current path. Other Sessions and abandoned paths remain project memory and can be recalled through `session_search` and `session_read`.

### Turns and workspace states

A turn contains its user message, assistant messages, tool execution facts, tool results, final status, parent turn, and a workspace-state ID. The order is fixed:

```text
show the user message and create a runtime-only planned turn
→ scan the workspace and start the first model request concurrently
→ bind the completed workspace-state ID and planned identity into a formal running turn
→ persist workspace and Session Tree records in the background
→ before any tool side effect, durably flush the workspace state and tool-start fact
→ durably finish the turn and advance the Session live tip
```

An interrupted or failed turn stays in history but does not advance the live tip. At startup, any turn left running is marked `interrupted`; tools are never automatically repeated.

The TUI projects the submitted user message immediately. A planned turn is runtime-only and exists just long enough to let the first model request overlap the workspace scan; it becomes a factual Session Tree turn only after the content-addressed workspace-state ID is known. Session Tree records then enter the in-memory projection synchronously and are written by one ordered background queue. Tool execution and final turn completion are durability barriers.

Workspace states are content-addressed manifests and blobs stored under `~/.thread/projects/<project-id>/workspace-states`. They include ignored files and empty directories. `.git`, `.thread`, Thread's own state path, paths outside the project, processes, databases, network effects, and other external state are excluded. Additional project-relative exclusions can be supplied through `ThreadAppOptions.workspaceExcludedPaths`.

### Rewind

`/rewind` lists only user turns on the active live path. Selecting a turn means “return to the moment before this user message ran”:

1. Verify and restore that turn's workspace state.
2. Move the active Session's live tip to the selected turn's parent.
3. Invalidate derived context compaction for the old path.
4. Keep the selected turn and all later turns in the Session Tree.

The next user message naturally creates a new child path. A missing or corrupt workspace state causes rewind to fail before the live tip moves.

### Context compaction

Compaction is a removable cache, not history. `/compact` summarizes an older prefix while retaining recent turns verbatim. Automatic compaction uses the same cache at 78% of the model window and after a provider reports overflow.

Deleting the compaction cache does not remove or rewrite any Session, Turn, or Entry. The full context can be rebuilt from the Session Tree.

## Commands

```text
/new
/session [<session-id>]
/rewind [<turn-id-or-user-entry-id>]
/compact
/model [all|list [provider]|<provider>/<model>]
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
  cache/compaction/
workspace-states/
  states/
  blobs/
```

The Session Tree log is append-only JSONL. A projection, search results, titles, token counts, and compaction summaries are derived data. The loader accepts only the current `thread-project-v1`, `thread-session-tree-v1`, and `thread-workspace-state-v1` formats. Old data is not read, migrated, upgraded, or partially interpreted.

## Configuration

The default model configuration is `~/.thread/config.json`. See `thread.config.example.json`. `THREAD_HOME`, `THREAD_CONFIG`, `THREAD_PROVIDER`, and `THREAD_MODEL` are supported. The most recent model and thinking level are remembered in `~/.thread/state.json` unless command-line selection overrides them.

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
src/workspace-state/  capture, integrity verification, and rewind restoration
src/context/          live-path input, budget, compaction cache
src/agent/            model/tool turn runtime and interruption handling
src/app/              composition and application use cases
src/commands/         command interface
src/ui/               plain and full-screen interfaces
```

## License

MIT. See `LICENSE`.
