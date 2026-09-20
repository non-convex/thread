# Working on Thread

Thread provides an embeddable agent runtime and a coding application with a TUI.
Keep this guide short; put detailed behavior and design notes in the linked docs.

## Code and documentation map

For the execution path and shared implementation boundaries, see the [code map](docs/code-map.md).

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

- Do not add, run or retain tests by default. A test is allowed only when a specific correctness risk cannot be resolved by focused code inspection or necessary static checks. State that risk and why testing is indispensable before using this exception. Routine edits, new features, renames, refactors and visual tweaks do not by themselves justify tests.
- If testing is indispensable, use the smallest temporary, focused check and stop once it resolves the concern. Remove its test code, fixtures, test-only configuration and dependencies, and generated output afterward, including files under `.cache/` and `dist/`. Do not keep permanent tests or introduce a test suite, test script or test CI job unless the user explicitly requests it.
- Prefer focused code inspection. Run static checks or builds only when needed for a concrete concern; do not routinely broaden or repeat verification.
- Do not add old-data compatibility, migration logic or legacy aliases unless the user explicitly requests them.
