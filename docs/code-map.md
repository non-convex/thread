# Reading the implementation

Thread has three layers. The runtime owns execution and durable project history. The coding app supplies product defaults and commands. The terminal UI observes those operations and presents them; it does not own the session repositories.

## From input to a durable turn

`src/app/thread-app.ts` opens the runtime, loads extensions and tracks the session selected by the coding app. `input-router.ts` parses a slash command once and dispatches it. Model selection and agent settings share the handlers in `commands/agents.ts`; Session Tree commands remain in `commands/builtins.ts`.

All execution enters `ThreadRuntime` in `src/core/runtime/thread-runtime.ts`. Startup resource acquisition lives in `resources.ts`. The runtime serializes foreground operations, captures the selected model and preferences for each turn, publishes events, and settles owned work before closing.

The execution path is:

```text
ThreadApp.handleInput → InputRouter → ThreadRuntime.prompt
  → AgentRunner → TurnRunner → AgentStepRunner
  → ToolExecutionBatch → ToolScheduler → ToolCallExecutor
```

These stages have different responsibilities. `AgentRunner` in `core/agent/runner.ts` admits and finishes the durable turn; `core/runtime/create-agent-runner.ts` assembles it from the project runtime's configured services. `TurnRunner` assembles context and handles compaction. `AgentStepRunner` owns one model response. A tool batch reconciles streamed calls with that response and preserves result order, while the scheduler controls concurrent execution. The executor validates and authorizes each invocation before calling the tool.

Model discovery, provider configuration and login belong to `agent/model-catalog.ts`. Streaming and retries belong to `agent/model-client.ts`. Both remain available through the existing public package exports.

`app/model-catalog.ts` limits the coding app's OpenAI Codex model lists to GPT-6 Astra, Sol, and Luna. The core catalog accepts an optional `isModelVisible` predicate for `list()` and `listAll()`; without it, embedded hosts retain the complete catalog. This display filter does not restrict explicit `createClient()` selections or change provider authentication.

## Persistence and file changes

The Session Tree and worker-task repositories own their record formats and projections. Both use `core/utils/event-log.ts` for ordered writes, durability barriers, interrupted-tail recovery and draining accepted writes during close. Projection updates remain synchronous; a durable append waits for its write before returning.

Session Tree and credential storage use `core/utils/file-lock.ts`. The operating system owns the lock, and closing the handle releases it. The lock file stays in place. JSON snapshots, including the Session Tree manifest, share `atomic-json.ts`. Built-in file tools and rewind use the underlying `atomic-file.ts` helper to prepare complete files before publishing them.

A file rewind records its source and target in the Session Tree before changing the workspace. Its completion event moves the live tip only after all restores succeed. If restoration fails, foreground work remains blocked; startup resumes the saved intent before exposing the runtime. Conversation-only rewind still moves the tip without a file-restoration intent.

File-tool resource claims are built by `tools/execution.ts`. Actual writes still go through `tools/file-write.ts`, where path checks, worker write scopes, same-path coordination and optional checkpoints are enforced. Sharing a claim helper does not replace the write-time checks.

The runtime protects its actual state directory from built-in file writes. The coding app adds all default project state, credentials and the credential lock to `protectedWritePaths`; hosts can protect more paths explicitly. Preparation and actual writes recheck this boundary, including after waiting for another writer. These checks do not constrain arbitrary shell or custom-tool I/O.

`tools/results.ts` contains the common result constructors and output bounds. Small and streamed file reads share one page collector. Grep's content and file-list modes share pagination metadata and notices. Web response limits, HTML conversion and character pagination live together in `tools/web-content.ts`.

`tools/view-image.ts` reads bounded local image files through the same file-read authorization boundary. `images/prepare.ts` validates, resizes and encodes pixels for both that tool and TUI attachments. Tool results keep display text separate from optional image blocks; the executor places the pixels in model messages and durable history, without duplicating them in presentation metadata.

## From runtime events to the terminal

The TUI controller receives runtime events and batches them through `ui/events.ts`. Coding command events originate in `app/events.ts` and arrive through `onCommandEvent`; the app never imports UI code. Core uses `onExecutionEvent` internally, and public prompt options forward only the documented fields. `ui/reducer.ts` updates presentation state. Main-agent and worker traces both use `ui/transcript-stream.ts`, so text completion and tool-call transitions follow the same rules. Historical transcript projection remains separate because it reads persisted records rather than deltas.

`contextSnapshot(sessionId)` supplies messages and usage from one context build. Context construction clones retained content rather than first cloning the complete live-path history. Public history queries still return independent snapshots. `scripts/check-boundaries.ts`, invoked by `bun run check`, enforces core/app import directions without executing the runtime.

`terminal/view.tsx` handles screen selection and keyboard priority. `composer-state.ts` owns the input draft and asynchronous clipboard work; clearing a draft prevents an earlier paste from updating the replacement draft. Question input is handled by `ask-input.ts` with answers stored on the displayed request.

`session-screen.tsx` positions the transcript, composer and a single floating-panel frame. The panel bodies live in `agent-overlays.tsx` and `session-overlays.tsx`, with shared row, heading and status presentation in `widgets.tsx`. These single-line widgets are deliberately separate from multiline transcript and diff rendering.

Picker objects are mutated in place. Renderers must read them through their original accessor rather than capture a `Show` callback value. Tool and turn IDs must also remain stable during live-to-history handoff so expansion and selection survive completion.
