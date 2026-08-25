# thread

English | [简体中文](README.zh-CN.md)

`thread` is a mini coding-agent harness in which a Project Session can span the life of a project, while the user remains free to choose a new session boundary. A thread version is the combination of a workspace snapshot and a conversation-context head. Thread branches, restore, diff and merge operate on those two dimensions together.

It deliberately does not reproduce all of Git. There is no staging area, rebase, stash or per-tool revision, and there is no separate external-memory store. Durable project knowledge is carried by the versioned conversation context and its compaction state.

## Requirements

- Bun 1.3.14 or newer when running from source
- Git 2.54 or a compatible build with `merge-tree --write-tree`
- A Git worktree

The source build uses the published `@earendil-works/pi-ai`, OpenTUI and SolidJS packages. It does not depend on pi-agent-core, pi-coding-agent, a local Zig toolchain or a local OpenTUI checkout.

```powershell
bun install
bun run build
bun link
```

Tagged releases also produce standalone Windows, Linux and macOS archives for x64 and Arm64 on the [GitHub Releases page](https://github.com/non-convex/thread/releases). A standalone binary already contains Bun, the Solid renderer and the matching OpenTUI native library; its user does not install those dependencies separately. The source checkout remains the smaller and easier option for development.

## Terminal interface

An interactive TTY starts a full-screen OpenTUI application. The session screen keeps a scrollable transcript, the active turn, status, composer and footer in one persistent Solid render tree. The transcript follows new output while it is at the bottom; the mouse wheel and Page Up/Page Down can inspect earlier visible entries. One agent turn — thinking, tool calls and reply — is tied together by an accent rail, completed thinking keeps a collapsible five-line preview, and tool rows carry their arguments and elapsed time. `/model`, `/session` and a bare `/rewind` open compact panels floating above the composer, so the conversation and input stay visible. `/thread merge`, `/thread history` and long command results open full in-app screens and return to the same session without entering its conversation. `/clear` only hides the transcript rendered in the current terminal process, and `/compact` forces bounded runtime context compaction.

On process startup, context restoration and subsequent turns, the visible transcript is bounded to the eight most recent complete user-led interactions. Thinking and compact tool traces inside that window remain visible and preserve arrival order. This bound affects only the in-app transcript; the durable session, model context and tool records remain intact.

Thinking, tool calls and assistant replies appear in arrival order, with quieter thinking text, compact tool rows and Markdown replies. User and assistant messages use OpenTUI's width-aware Markdown renderer. Headings, emphasis, inline and fenced code, quotes, lists, links and tables receive terminal-native layout and semantic colors. Streaming reply blocks retain one Markdown renderable and update it incrementally instead of rebuilding it for every token batch.

```powershell
thread --tui fullscreen   # default: full-screen OpenTUI
thread --tui plain        # readline/text output
```

`--tui hybrid` and `--tui regular` remain accepted as compatibility aliases for `fullscreen`. Non-TTY input or output automatically selects plain mode. In floating panels and full screens, use arrow/Page Up/Page Down keys to scroll or move and `Esc` to return. `Ctrl+C` interrupts active work; press it twice while idle to exit. For reasoning models, `Shift+Tab` cycles the model's supported thinking levels. The OpenTUI editor supports multiline input (`Shift+Enter`), bracketed paste, project-path completion and terminal-aware cursor positioning.

## Run

After the one-time `bun link` (or after placing a standalone binary on `PATH`), launch the harness from the project you want to work on. The current directory is resolved to its containing Git worktree root:

```powershell
Set-Location .\your-git-worktree
thread
```

User model configuration is global and is never read from or written to the project worktree. Its default location is `~/.thread/config.json` (`%USERPROFILE%\.thread\config.json` on Windows):

```powershell
New-Item -ItemType Directory -Force "$HOME\.thread"
Invoke-WebRequest "https://raw.githubusercontent.com/non-convex/thread/main/thread.config.example.json" `
  -OutFile "$HOME\.thread\config.json"
$env:MY_RELAY_API_KEY = "<secret>"
thread
```

Set `THREAD_HOME` to relocate the whole user configuration directory. Use `--config <path>` or `THREAD_CONFIG` to select a different file. API keys are intentionally referenced by `apiKeyEnv`; do not put secrets in the JSON file.

If the thread config file does not exist, the harness falls back to pi's existing global configuration:

```text
~/.pi/agent/models.json       provider and model definitions
~/.pi/agent/settings.json     defaultProvider, defaultModel and defaultThinkingLevel
```

`PI_CODING_AGENT_DIR` is honored when pi uses a non-default directory. This is a fallback, not a merge: once `~/.thread/config.json` exists (or an explicit `--config` is supplied), pi configuration is not loaded. A missing explicit config is an error. Pi `apiKey` literals, environment templates such as `$KEY`/`${KEY}`, and `!command` values are resolved without copying secrets into the Project Session.

```json
{
  "model": { "provider": "my-relay", "id": "claude-sonnet-4-6" },
  "defaultThinkingLevel": "medium",
  "providers": {
    "my-relay": {
      "name": "My relay",
      "api": "anthropic-messages",
      "baseUrl": "https://relay.example.com",
      "apiKeyEnv": "MY_RELAY_API_KEY",
      "models": [
        {
          "id": "claude-sonnet-4-6",
          "contextWindow": 200000,
          "maxTokens": 64000,
          "reasoning": true,
          "input": ["text", "image"]
        }
      ]
    }
  }
}
```

Supported custom APIs in v1 are `anthropic-messages`, `openai-completions`, and `openai-responses`. `contextWindow` is required because the harness uses it to decide when to compact; set it to the relay model's real limit. `defaultThinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` and defaults to `medium`. Optional provider `headers`, model `samplingParams`, per-model `thinkingLevelMap`, and pi-ai `compat` overrides are also accepted. A `thinkingLevelMap` value of `null` marks that level as unsupported.

For a built-in pi-ai provider, the config only needs the model selection and the provider's normal credential environment variable:

```json
{
  "model": { "provider": "openai", "id": "<model-id>" }
}
```

CLI/environment selection still works and takes precedence over the file:

```powershell
$env:THREAD_PROVIDER = "openai"
$env:THREAD_MODEL = "<model-id>"
thread
```

The version commands remain usable without any configured model — the one exception is `/thread diff`, which runs as an agent turn:

```powershell
thread
```

Normal text enters the streaming multi-step agent loop. `/new`, `/session ...`, `/model`, `/clear`, `/compact`, `/thread ...` and `/rewind ...` are intercepted before the LLM and never become ordinary user messages.

## Project sessions

`/new` starts a new Project Session from the workspace exactly as it is now. Thread first records a safety checkpoint in the old session, then creates a new `main` branch with a genesis workspace snapshot and an empty conversation context. It does not generate a handoff, call the model or copy messages. The selected model, thinking level, tools and loaded extensions remain active because they belong to the running process rather than the session context.

Use `/session` or `/session list` to inspect retained sessions, and `/session switch <session-id-or-unique-prefix>` to return to one. In the TUI, bare `/session` opens a floating picker; use ↑/↓, Enter and Esc. Switching first saves the current workspace, then restores both the target session's workspace and context. The most recently created or explicitly activated session becomes the default on the next launch.

## Model switching

The active model can be inspected or changed without restarting `thread`:

```text
/model
/model all
/model list
/model list <provider>
/model <provider>/<model>
/model <provider> <model>
```

In the full-screen TUI, selecting `model` from slash-command completion and pressing Enter opens a panel above the composer containing models explicitly declared in the active thread/pi configuration. The current model is always included and marked with `●`, even when it came from the built-in catalog or a direct switch. Use ↑/↓ to move, Enter to switch, and Esc to dismiss the panel. `/model all` opens the complete built-in and configured catalog; long catalogs stay centered around the selected row.

For a reasoning model, press `Shift+Tab` on the session screen to cycle through the levels that model declares as supported. The active level appears beside the model in the footer. It is applied consistently to the main agent loop, automatic and manual compaction, Context Capsules, semantic diffs, and context merges. Switching models clamps the current preference to the new model's capabilities. When thread falls back to pi configuration, it inherits pi's `defaultThinkingLevel`; otherwise the default is `medium`.

Plain mode keeps `/model` as a status command. `/model list` prints the configured/current choices, while `/model list <provider>` prints every catalog model registered under one provider. Direct `/model <provider>/<model>` switching can still select a model from the complete catalog even when it is hidden from the default picker. A switch retains the current conversation and workspace, while rebuilding the main agent loop, compactor, Context Capsule, semantic diff and context-merge services around the selected model. The TUI model label and context-window percentage update immediately.

Model and thinking-level changes affect only the running process. They do not edit global configuration or append a message/checkpoint, so a restart again uses `--provider`/`--model`, `THREAD_PROVIDER`/`THREAD_MODEL`, and the configured defaults in normal precedence order.

## Web tools

The built-in `websearch` tool searches through Exa's MCP endpoint by default. Set `THREAD_WEBSEARCH_PROVIDER=parallel` to use Parallel instead; `exa` is the other accepted value. `EXA_API_KEY` and `PARALLEL_API_KEY` add provider credentials when present, while both integrations may still be attempted without a key according to the provider's own access policy. Search accepts one query, an optional result count (maximum 20), live-crawl preference, search depth and context-size bound.

The built-in `webfetch` tool retrieves one HTTP(S) URL as Markdown, plain text or HTML. It has a 30-second default timeout (120-second maximum), rejects responses larger than 5 MiB and limits model-visible converted output to 200,000 characters. Binary responses are rejected. Both web tools are recorded as non-replayable so interrupted requests are never automatically issued again.

`webfetch` follows HTTP redirects and does not currently block private, loopback or link-local destinations. The harness also has no web-specific approval policy, so do not expose it to an untrusted model in an environment where HTTP access can reach sensitive internal services.

## Version commands

```text
/clear
/compact
/new
/session [list]
/session switch <session-id-or-unique-prefix>
/model [all | list [<provider>] | <provider>/<model> | <provider> <model>]
/thread status
/thread branches
/thread branch <name> [<from>]
/thread switch <branch>
/thread log [<branch>] [--graph|--all]
/thread reflog [<branch>]
/thread show <ref>
/thread history
/thread commit <message>
/thread diff [<from> <to>] [--facts]
/thread restore <ref> [--workspace|--context|--both]
/thread merge <ref> [--context=keep-current|summarize]
/rewind [<turn-id-or-user-entry-id>]
```

`/clear` changes no durable state: it hides messages through the current context head, while later messages continue to use the complete backend context. Restarting the terminal or navigating to another context may show those messages again.

`/compact` forces runtime context compaction without adding a user message. Compaction **forks the live conversation**: it reuses the byte-identical prefix (system prompt plus messages) and appends one compaction instruction as the newest user message, so the request hits the provider's prompt cache and the model reads what it actually experienced instead of a projected transcript. The reply never enters the agent loop; it only replaces the context. Because the fork carries the same prefix it is about to compact, compaction triggers at **78% of the context window** rather than waiting until the next ordinary request no longer fits. The post-compaction input target is 7% of the model context window, including the system prompt, tools, extension context, generated project state and retained raw interactions. The final project state has a 4K-token ceiling and is organized under three fixed headings: `Long-term memory` keeps at most 25 dated `- [YYYY-MM-DD] (…)` entries of durable knowledge, reorganized on every compaction; `Current project state` describes the material current goal, changes, validation, unresolved problems and next action; `Recent user-agent conversation` keeps at most 10 `- [YYYY-MM-DD HH] (…)` entries, oldest first, evicted purely by time so anything with durable value has to graduate into long-term memory. Both dated sections treat their timestamp as a last-modified stamp: because the provider message format carries no timestamps, the fork instruction states the current local date and hour, and the model stamps only what it writes or revises while carrying unchanged entries forward with their existing stamp. Within the remaining tail budget the compactor retains as many recent complete user-led interactions as fit, with a minimum of two. If those two interactions already exceed the target they remain intact, so 7% is a target rather than a destructive hard limit. It creates an internal checkpoint so the branch context head remains recoverable and is not an `/thread commit`. If there is no older interaction to absorb, it is a no-op. If a single oversized turn jumps past the trigger so the fork itself cannot fit, compaction fails loudly and asks for `/clear` or `/rewind` instead of degrading silently.

`HEAD`, thread branch names, full IDs and unambiguous commit/checkpoint ID prefixes are valid refs. Thread branches are independent of the main repository's Git branches: switching a thread branch never moves the main Git HEAD, index, refs or reflog.

`/thread diff` is captured and re-issued to the agent as a wrapped user message instead of running through a dedicated diff service. The agent reads the version data itself with its normal tools — the sidecar session log, object store and Context Capsules are described in its system prompt — and answers as an ordinary turn, so the exchange becomes append-only session history. A bare `/thread diff` compares the last thread commit with the current state; `<from> <to>` compares two explicit versions, and `--facts` asks for deterministic facts without interpretation. Committed endpoints carry a Context Capsule the agent may consult when its own memory of that version has been compacted; the current-state endpoint never has one, so the agent relies on its live memory. Because it is an agent turn, `/thread diff` requires a configured model.

A bare `/rewind` in the TUI opens a panel listing recent user messages with their times; arrow keys move the highlight and Enter must be pressed twice, because the second press discards everything after the selected message. Passing an explicit ID rewinds directly. `/thread history` shows the same turns as a full screen, and both restore through the same path.

Workspace merge is three-way and v1 only applies clean results. In the TUI, `/thread merge <ref>` opens a preview, lets the user choose a context strategy, and requires confirmation before applying. `keep-current` retains the current context without a model call. `summarize` first shows a model-generated, read-only handoff note and only writes it to context after confirmation. Plain/non-interactive use can execute directly with an explicit `--context=keep-current|summarize` flag.

## Persistence model

Global configuration and repository-attached version state are deliberately separate:

```text
~/.thread/
└── config.json                 global model/provider configuration

~/.pi/agent/                    read-only fallback when config.json is absent
├── models.json
└── settings.json

<git-common-dir>/thread/        workspace + context version medium for this repository
```

Data lives under the worktree's Git common directory:

```text
<git-common-dir>/thread/
├── store.git/                  independent sidecar object database
├── projects/<project-id>.json  active session and activation order for one worktree
├── indexes/<session-id>        private Git index
├── sessions/<session-id>/
│   ├── events.jsonl            canonical append-only Project Session log
│   ├── session.json
│   └── cache/                   rebuildable capsules and semantic diffs
├── locks/                      project and session process locks
└── tmp/
```

The JSONL log is replayed into an in-process projection at startup. A partial final line is discarded; corruption in the middle stops recovery. State changes that must appear together are written as one batch record. `tool_started` for a `replay=never` tool is flushed before the side effect, and startup recovery never blindly executes it again.

Workspace objects are fully owned by the independent sidecar. Its chronological retention commits only keep objects reachable; Checkpoint DAG ancestry comes from `events.jsonl`. Startup reconciliation repairs a keep ref that lags the latest durable checkpoint.

Snapshots cover main-repository tracked files and non-ignored untracked files. They exclude ignored files, empty directories, submodule internals, paths outside the worktree, processes, databases, network effects and other external side effects. Restore creates a safety checkpoint and refuses ignored/out-of-scope collisions. Gitlink metadata is preserved in trees, while submodule internals are intentionally not restored.

## Context and compaction

Raw session entries are append-only. Runtime compaction appends an updated project state plus retained tail instead of deleting earlier entries. Automatic compaction triggers on a ratio of the context window, leaving room for the forked compaction request to be sent at all. Context Capsules are bounded, lossy caches attached to checkpoints; explicit commits try to create one eagerly, while merges create missing capsules lazily. Capsules still use the deterministic semantic message projection (provider bookkeeping, hidden thinking and duplicate raw tool details excluded); compaction no longer needs it because it forks the real conversation.

There is no separate project-memory service, retrieval projection or built-in memory tool. Long-term project knowledge must survive through the compacted conversation state, so it follows the same branch, checkpoint, restore, diff and merge boundaries as the rest of the session context.

## Extensions

Trusted local extensions can register tools, `/thread` commands and five events: `turn_start`, `before_context`, `before_tool_call`, `tool_result` and `turn_end`.

```powershell
bun start -- --root . --extension .\examples\extension.mjs
```

See [examples/extension.mjs](examples/extension.mjs). Core tool and command names are reserved; duplicate registration fails.

## Public API

`ThreadApp.open()` can be embedded with an injected `ModelClient`, which is also how the faux provider is used for the minimal end-to-end smoke. Its `session`, `versions`, `capsules`, `diff` and `merge` properties always refer to the active session runtime. `app.fsck()` checks the project catalog, every retained session log/keep ref and sidecar objects. `app.deleteProjectSession()` explicitly deletes only the active session's log, private index and keep ref, restores the most recently activated remaining session when one exists, then runs sidecar GC; it does not delete the main worktree.

## Verification policy

`bun run check`, `bun test` and `bun run build` are the local verification entry points. The intentionally compact suite covers the Project Session version loop, multi-session creation/migration/switching, sidecar and replay safety, asynchronous turn preparation, model/thinking behavior, Web tools, full-screen session updates, stable streaming Markdown identity, wheel scroll acceleration, turn grouping, the redesign's rendered language, view-side navigation of the `/model`, `/session` and `/rewind` panels, controller screen routing and composer submission. It does not duplicate OpenTUI or `pi-ai` dependency tests. Tagged releases compile on native x64/Arm64 Windows, Linux and macOS runners.

## External projects and attribution

`thread` uses or was informed by the following external open-source projects:

- [earendil-works/pi](https://github.com/earendil-works/pi): the published [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) package provides model/provider APIs. `src/utils/estimate.ts` derives its context-estimation logic from pi and retains the upstream MIT attribution below.
- [OpenTUI](https://github.com/anomalyco/opentui), [SolidJS](https://github.com/solidjs/solid) and [Bun](https://github.com/oven-sh/bun): OpenTUI's Zig-backed core and Solid renderer provide the terminal layout/rendering runtime; SolidJS provides reactive UI state propagation; Bun runs, builds and compiles the application. Thread pins compatible OpenTUI/Solid versions and ships the native library inside standalone binaries.
- [OpenCode](https://github.com/anomalyco/opencode): its route-oriented OpenTUI architecture and its [`websearch`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/websearch.ts) / [`webfetch`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/webfetch.ts) tools informed Thread's temporary-screen boundaries and Web-tool behavior. Thread's implementation is adapted to its own state and tool runtime.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): its [`tool-web`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/web/tool-web) package was reviewed when comparing web-search, fetch and SSRF trade-offs.
- [htmlparser2](https://github.com/fb55/htmlparser2) and [Turndown](https://github.com/mixmark-io/turndown): direct runtime dependencies used for HTML parsing and HTML-to-Markdown conversion in `webfetch`.

The direct dependencies above are distributed under the MIT License. The following notice is retained for the context-estimation code derived from pi:

```text
MIT License
Copyright (c) 2025 Mario Zechner
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## License

`thread` is released under the [MIT License](LICENSE). Third-party portions remain subject to their respective notices above.
