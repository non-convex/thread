# Working on Thread

Thread provides an embeddable agent runtime and a coding application with a TUI.
Keep this guide short; put detailed behavior and design notes in the linked docs.

## Code and documentation map

- `src/runtime.ts`, `src/core/runtime/`: public runtime API, configuration, events and lifecycle. See [runtime usage](docs/runtime.md).
- `src/core/agent/`, `src/core/tools/`: model loop, tool execution and shared file-write boundary.
- `src/app/`, `src/cli/`, `src/ui/`: coding defaults, commands, startup and presentation. See [TUI behavior](docs/tui.md).
- `src/core/session-tree/`, `src/core/context/`, `src/core/file-history/`: durable history, model context and optional file checkpoints. See [session tools](docs/session-tools.md).
- `src/core/agent-task/`: workers in the shared workspace. See [worker architecture](docs/worker-architecture.md).
- `src/core/session-recall/`, `src/core/dreamer/`: history retrieval and memory consolidation. See [Recall](docs/session-recall.md) and [global memory](docs/global-memory-architecture.md).
- `examples/runtime.ts`: independent host example.

## Design constraints

- Hosts embed through `thread/runtime`; its implementation lives entirely in `src/core/`. Core imports, including types, must stay within core or external dependencies, never the coding app, CLI, TUI or package entries.
- `ThreadApp` composes a runtime; product defaults and project instruction discovery belong in the app. Use `app.runtime` for execution and queries, not private repositories or mutable projections.
- Preserve coding CLI/TUI behavior when changing runtime internals. Keep core defaults minimal and capability configuration explicit.
- Session history and model context serve different purposes. Disabling file checkpoints must preserve session persistence, path checks, write coordination and cancellation.
- `prompt()`, `interrupt()` and `close()` must settle the work they own. Propagate cancellation to I/O and leave shared host resources under host ownership.
- Workers share the project directory. Enforce their declared scope through the built-in file-write boundary; it is not an OS sandbox for bash or arbitrary custom tools.
- Prefer existing tools, runners and services over parallel implementations or speculative frameworks. Update the relevant guide when a public contract changes.

## Change scope

- Do not add or run tests unless strictly necessary. Routine edits, renames and refactors do not require tests by default.
- Do not add old-data compatibility, migration logic or legacy aliases unless the user explicitly requests them.
