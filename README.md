# thread

English | [简体中文](README.zh-CN.md)

`thread` is a coding-agent runtime built around one persistent **Session Tree** per Git worktree. Each point in that tree binds the workspace the agent changed to the conversation context that explains why. Branch, restore, diff, merge, rewind, squash and fresh-context starts all operate on that shared history.

It deliberately does not reproduce all of Git. There is no staging area, rebase, stash or per-tool revision, and there is no separate external-memory store. Durable project knowledge lives in the versioned session context and follows the same branches and restore boundaries as the workspace.

## The Session Tree

The Session Tree is the user-facing model for a long-lived coding session:

```text
thread branch ──► checkpoint
                   ├── workspaceTreeOid ──► sidecar workspace snapshot
                   └── sessionHeadId ─────► context entry leaf
                                                │ parentId
                                                ▼
                                           ... entry root
```

Every checkpoint joins two durable identities:

- a workspace tree stored in thread's independent sidecar Git object database;
- a context head whose `parentId` path is exactly the message sequence sent to the model.

Thread branches point to checkpoints, not to the main repository's Git refs. Restoring a checkpoint can restore the workspace, the context path, or both. A merge checkpoint may have two parents, so the checkpoint structure is technically a DAG; “Session Tree” names the navigable product concept that contains the checkpoint graph, context-entry tree and branch pointers.

Context history is append-only, but the active context is path-based. A normal turn extends the current entry leaf. A squash creates a new path that skips an older interval; it does not delete that interval. Old checkpoints still point to the old path, so history remains auditable and restorable without making `buildContext()` carry a second barrier interpretation.

`/new` stays inside this tree. It first saves the current branch, then creates an automatically named branch directly below the genesis checkpoint. The new checkpoint borrows the current workspace snapshot but sets its context head to `null`: files remain as they are, while the conversation starts empty. The old workspace and context remain recoverable on the old branch.

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

An interactive TTY starts a full-screen OpenTUI application. The session screen keeps a scrollable transcript, the active turn, status, composer and footer in one persistent Solid render tree. The transcript follows new output while it is at the bottom; the mouse wheel and Page Up/Page Down can inspect earlier visible entries. One agent turn — thinking, tool calls and reply — is tied together by an accent rail, completed thinking keeps a collapsible five-line preview, and tool rows carry their arguments and elapsed time. `/model`, a bare `/rewind` and a bare `/thread squash` open compact panels floating above the composer, so the conversation and input stay visible. `/thread merge`, `/thread history` and long command results open full in-app screens and return to the same Session Tree without entering its conversation. `/clear` only hides the transcript rendered in the current terminal process, and `/compact` creates a shorter active context path.

On process startup, context restoration and subsequent turns, the visible transcript is bounded to the eight most recent complete user-led interactions. Thinking and compact tool traces inside that window remain visible and preserve arrival order. This bound affects only the in-app transcript; the durable session, model context and tool records remain intact.

Thinking, tool calls and assistant replies appear in arrival order, with quieter thinking text, compact tool rows and Markdown replies. User and assistant messages use OpenTUI's width-aware Markdown renderer. Headings, emphasis, inline and fenced code, quotes, lists, links and tables receive terminal-native layout and semantic colors. Streaming reply blocks retain one Markdown renderable and update it incrementally instead of rebuilding it for every token batch.

```powershell
thread --tui fullscreen   # default: full-screen OpenTUI
thread --tui plain        # readline/text output
```

`--tui hybrid` and `--tui regular` remain accepted as compatibility aliases for `fullscreen`. Non-TTY input or output automatically selects plain mode. In floating panels and full screens, use arrow/Page Up/Page Down keys to scroll or move and `Esc` to return. `Ctrl+C` interrupts active work; press it twice while idle to exit. For reasoning models, `Shift+Tab` cycles the model's supported thinking levels. The OpenTUI editor supports multiline input (`Shift+Enter`), bracketed paste, project-path completion and terminal-aware cursor positioning.

## Run

After the one-time `bun link` (or after placing a standalone binary on `PATH`), launch thread from the project you want to work on. The current directory is resolved to its containing Git worktree root:

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

Interactive `/model` and `Shift+Tab` choices are remembered in `~/.thread/state.json`, so the next start reuses the model and thinking level you last selected instead of returning to the configured default. This file is a disposable cache: deleting it simply returns the next start to `config.json`, and thread never writes to `config.json` itself. Startup precedence is `--provider`/`--model` (or `THREAD_PROVIDER`/`THREAD_MODEL`) first, then the remembered choice, then the configured default. If a remembered model no longer exists — for example after editing the provider list — thread reports that and falls back to the configured default rather than refusing to start.

If the thread config file does not exist, thread falls back to pi's existing global configuration:

```text
~/.pi/agent/models.json       provider and model definitions
~/.pi/agent/settings.json     defaultProvider, defaultModel and defaultThinkingLevel
```

`PI_CODING_AGENT_DIR` is honored when pi uses a non-default directory. This is a fallback, not a merge: once `~/.thread/config.json` exists (or an explicit `--config` is supplied), pi configuration is not loaded. A missing explicit config is an error. Pi `apiKey` literals, environment templates such as `$KEY`/`${KEY}`, and `!command` values are resolved without copying secrets into the Session Tree.

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

Supported custom APIs in v1 are `anthropic-messages`, `openai-completions`, and `openai-responses`. `contextWindow` is required because thread uses it to decide when to compact; set it to the relay model's real limit. `defaultThinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` and defaults to `medium`. Optional provider `headers`, model `samplingParams`, per-model `thinkingLevelMap`, and pi-ai `compat` overrides are also accepted. A `thinkingLevelMap` value of `null` marks that level as unsupported.

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

Structural navigation remains usable without a configured model. Commands that call a model—ordinary turns, `/compact`, `/thread squash`, `/thread diff`, `/thread commit`, and merge with `--context=summarize`—require one:

```powershell
thread
```

Normal text enters the streaming multi-step agent loop. Slash commands are recognized before model dispatch. Most return command results; `/thread diff` is deliberately wrapped as a normal user turn, while `/thread squash` creates a synthetic squash turn and then continues through the same agent loop.

## Fresh context branches

`/new` creates a fresh context boundary without creating another Session Tree. Thread first records an unconditional safety checkpoint on the old branch. It then creates `new-1`, `new-2`, and so on beneath the unique genesis checkpoint, using the safety checkpoint as the explicit source of its workspace tree and retention identity while setting `sessionHeadId = null`. The operation does not restore the genesis workspace, generate a handoff, call the model or copy messages.

The new branch therefore begins with the files exactly as they were when `/new` ran, but with no conversation messages. Switching back to the old thread branch restores its previous workspace and context. The selected model, thinking level, tools and loaded extensions remain active because they belong to the running process rather than to one branch.

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

For a reasoning model, press `Shift+Tab` on the session screen to cycle through the levels that model declares as supported. The active level appears beside the model in the footer. It is applied consistently to the main agent loop, automatic and manual compaction, Context Capsules, and context merges. Switching models clamps the current preference to the new model's capabilities. When thread falls back to pi configuration, it inherits pi's `defaultThinkingLevel`; otherwise the default is `medium`.

Plain mode keeps `/model` as a status command. `/model list` prints the configured/current choices, while `/model list <provider>` prints every catalog model registered under one provider. Direct `/model <provider>/<model>` switching can still select a model from the complete catalog even when it is hidden from the default picker. A switch retains the current conversation and workspace, while rebuilding the main agent loop, compactor, Context Capsule and context-merge services around the selected model. The TUI model label and context-window percentage update immediately.

Model and thinking-level changes take effect immediately in the running process and do not edit global configuration or append a message/checkpoint. They are remembered in `~/.thread/state.json`, so a restart reuses the last selection unless `--provider`/`--model` or `THREAD_PROVIDER`/`THREAD_MODEL` overrides it.

## Shell tool

The built-in `bash` tool runs foreground commands in the workspace root. On Windows it prefers Git Bash, so commands behave as the tool name promises and match the POSIX shell used on other platforms. Git Bash is located from `THREAD_GIT_BASH`, then from the installation that owns `git` on `PATH`, then from the standard `%ProgramFiles%` paths — an install on another drive is therefore found. A `bash.exe` on `PATH` is deliberately ignored, because on Windows that name is normally the WSL launcher rather than Git Bash.

When no Git Bash is installed, thread falls back to `pwsh` and then `powershell.exe`; both receive a UTF-8 preamble and propagate the last native exit code. Candidates are tried in order and a later one is used only when the shell itself fails to launch, never when the command runs and reports a non-zero exit code. Exit codes, stdout and stderr are kept separate, and every invocation is non-interactive with the user's profile disabled.

## Grep tool

The built-in `grep` tool searches workspace text with ripgrep. Matches are grouped by file and ranked so git-changed files appear first, then recently modified files, rather than dumping hits in scan order. Each call returns one page (default 20 matches, maximum 100) and includes a cursor to continue the same search. `outputMode=files` returns ranked paths with counts and no line text. Hidden files are not searched; `.gitignore` is respected. `rg` must be on `PATH`.

## Web tools

The built-in `websearch` tool searches through Exa's MCP endpoint by default. Set `THREAD_WEBSEARCH_PROVIDER=parallel` to use Parallel instead; `exa` is the other accepted value. `EXA_API_KEY` and `PARALLEL_API_KEY` add provider credentials when present, while both integrations may still be attempted without a key according to the provider's own access policy. Search accepts one query, an optional result count (maximum 20), live-crawl preference, search depth and context-size bound.

The built-in `webfetch` tool retrieves one HTTP(S) URL as Markdown, plain text or HTML. It has a 30-second default timeout (120-second maximum), rejects responses larger than 5 MiB and limits model-visible converted output to 200,000 characters. Binary responses are rejected. Both web tools are recorded as non-replayable so interrupted requests are never automatically issued again.

`webfetch` follows HTTP redirects and does not currently block private, loopback or link-local destinations. Thread also has no web-specific approval policy, so do not expose it to an untrusted model in an environment where HTTP access can reach sensitive internal services.

## Version commands

```text
/clear
/compact
/new
/model [all | list [<provider>] | <provider>/<model> | <provider> <model>]
/thread status
/thread branches
/thread branch <name> [<from>]
/thread switch <branch>
/thread log [<branch>] [--graph|--all]
/thread reflog [<branch>]
/thread show <ref>
/thread history
/thread squash [<turn-id-or-user-entry-id>]
/thread commit <message>
/thread diff [<from> <to>] [--facts]
/thread restore <ref> [--workspace|--context|--both]
/thread merge <ref> [--context=keep-current|summarize]
/rewind [<turn-id-or-user-entry-id>]
```

`/clear` changes no durable state: it hides messages through the current context head, while later messages continue to use the complete backend context. Restarting the terminal or navigating to another context may show those messages again.

`/compact` performs a root squash without adding a user turn. It **forks the exact live request prefix**—system prompt, tools, extension context and messages—and appends one read-only summary instruction. Tool definitions stay present so the prefix identity is preserved, but the instruction forbids tools and the fork runtime rejects every returned tool call without executing it. The resulting `project_state` entry becomes a new context root and expands its embedded retained tail; `buildContext()` then follows only that new root-to-leaf path. The old path is still available through its old checkpoints.

Automatic squash uses the same root operation at **78% of the context window**, and again after a provider reports context overflow. The post-squash input target is 7% of the model window, including system prompt, tools, extension overhead, the bounded workspace diffstat, generated project state and retained raw turns. The project-state summary has a 4K-token ceiling and keeps the fixed `Long-term memory`, `Current project state`, `Recent user-agent conversation`, `Lessons learned` and `Notes worth keeping` sections. `Lessons learned` records at most 10 dated failures and hard-won experience from the current work; `Notes worth keeping` records at most 10 hour-stamped points about the user rather than the project. Both are maintained like long-term memory — obsolete entries dropped, overlapping ones merged — and both are deliberately admission-strict, staying empty rather than accumulating routine outcomes or generic advice. Retention starts at a complete user-turn boundary and keeps at least the two newest turns; those two are the only reason the 7% target may be exceeded. If the exact fork or the final safe request cannot fit, squash fails explicitly and asks for `/clear` or `/rewind`.

`/thread squash` is the selective form. With no argument it opens a one-Enter picker containing only real user turns on the current context path. With a turn or user-entry ID, it summarizes that turn through the current leaf into a 2K-token `incremental` squash entry whose parent is the entry immediately before the selected turn. It then continues as a normal agent turn through the shared model/tool loop. The squash turn has a normal turn base, so `/rewind` restores both the pre-squash context path and workspace. Retained or off-path turns cannot be selected.

Every squash checkpoint reuses its parent's workspace tree and retention commit; it does not capture, restore or mutate the sidecar keep ref. Its machine-generated diffstat describes checkpointed workspace changes separately from the model narrative. The checkpoint records the trigger, rewritten boundary, source context head and summarized counts in the reflog.

`HEAD`, thread branch names, full IDs and unambiguous commit/checkpoint ID prefixes are valid refs. Thread branches are independent of the main repository's Git branches: switching a thread branch never moves the main Git HEAD, index, refs or reflog.

`/thread diff` is captured and re-issued to the agent as a wrapped user message instead of running through a dedicated diff service. The agent reads the version data itself with its normal tools — the sidecar session log, object store and Context Capsules are described in its system prompt — and answers as an ordinary turn, so the exchange becomes append-only session history. A bare `/thread diff` compares the last thread commit with the current state; `<from> <to>` compares two explicit versions, and `--facts` asks for deterministic facts without interpretation. Committed endpoints carry a Context Capsule the agent may consult when its own memory of that version has been compacted; the current-state endpoint never has one, so the agent relies on its live memory. Because it is an agent turn, `/thread diff` requires a configured model.

A bare `/rewind` in the TUI opens a panel listing user turns with their path status and time; arrow keys move the highlight and Enter must be pressed twice, because the second press discards everything after the selected turn. Passing an explicit ID rewinds directly. `/thread history` classifies turns as current-path, retained, off-path or synthetic-squash instead of filtering by the branch name that originally created them.

`/thread commit` records the context percentage shown by the TUI together with the estimated token count, context-window size, provider, model and estimator version. The saved percentage remains historical evidence if the active model changes; `/thread show` can also recompute that checkpoint's context against the current model window.

Workspace merge is three-way and v1 only applies clean results. In the TUI, `/thread merge <ref>` opens a preview, lets the user choose a context strategy, and requires confirmation before applying. `keep-current` retains the current context without a model call. `summarize` first shows a model-generated, read-only handoff note and only writes it to context after confirmation. Plain/non-interactive use can execute directly with an explicit `--context=keep-current|summarize` flag.

## Persistence model

Global configuration and repository-attached version state are deliberately separate:

```text
~/.thread/
├── config.json                 global model/provider configuration
└── state.json                  remembered model + thinking level (disposable)

~/.pi/agent/                    read-only fallback when config.json is absent
├── models.json
└── settings.json

<git-common-dir>/thread/        workspace + context version medium for this repository
```

Data lives under the worktree's Git common directory:

```text
<git-common-dir>/thread/
├── store.git/                  independent sidecar object database
├── indexes/<tree-id>           private Git index
├── trees/<tree-id>/
│   ├── events.jsonl            canonical append-only Session Tree log
│   ├── tree.json
│   └── cache/                   rebuildable Context Capsules
├── locks/                      Session Tree process lock
└── tmp/
```

The JSONL log is replayed into an in-process projection at startup. The current schema is explicitly `formatVersion: 3`. Format 2 multi-session logs, pre-squash logs, old `compaction` entries, removed navigation operations and commits without context-cost metadata are rejected at the loading boundary; thread does not carry an old-data compatibility reader or rewrite old logs in place. One worktree resolves to one deterministic Session Tree ID. A partial final line is discarded, while corruption in the middle stops recovery. State changes that must appear together are written as one batch record. `tool_started` for a `replay=never` tool is flushed before the side effect, and startup recovery never blindly executes it again.

Workspace objects are fully owned by the independent sidecar. Its chronological retention commits only keep objects reachable; Checkpoint DAG ancestry comes from `events.jsonl`. Startup reconciliation repairs a keep ref that lags the latest durable checkpoint.

Snapshots cover main-repository tracked files and non-ignored untracked files. They exclude ignored files, empty directories, submodule internals, paths outside the worktree, processes, databases, network effects and other external side effects. Restore creates a safety checkpoint and refuses ignored/out-of-scope collisions. Gitlink metadata is preserved in trees, while submodule internals are intentionally not restored.

## Context paths and squash

Session entries are append-only and form a single-parent tree. `buildContext(headId)` follows `parentId` from the selected leaf to `null`, reverses that path and renders each entry; it has no compaction barrier scan or legacy fallback. A root `project_state` squash renders one machine-facts-plus-narrative message followed by its embedded retained messages. An `incremental` squash renders one synthetic user request and has no retained tail.

Context Capsules are bounded, lossy caches attached to checkpoints; explicit commits try to create one eagerly, while merges create missing capsules lazily. Capsules still use a deterministic semantic projection. Squash does not: its summary fork receives the exact live request prefix and is read-only.

There is no separate project-memory service, retrieval projection or built-in memory tool. Long-term project knowledge must survive through the compacted conversation state, so it follows the same branch, checkpoint, restore, diff and merge boundaries as the rest of the session context.

## Extensions

Trusted local extensions can register tools, `/thread` commands and five events: `turn_start`, `before_context`, `before_tool_call`, `tool_result` and `turn_end`.

```powershell
bun start -- --root . --extension .\examples\extension.mjs
```

See [examples/extension.mjs](examples/extension.mjs). Core tool and command names are reserved; duplicate registration fails.

## Public API

`ThreadApp.open()` can be embedded with an injected `ModelClient`. Its `session`, `versions`, `capsules` and `merge` properties refer to the worktree's single Session Tree runtime. `app.fsck()` checks that tree's branches, commits, checkpoints, keep ref and sidecar objects.

## Verification policy

`bun run check` and `bun run build` are the local verification entry points. Tagged releases compile on native x64/Arm64 Windows, Linux and macOS runners.

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
