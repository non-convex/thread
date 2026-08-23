# thread

`thread` is a mini coding-agent harness in which a Project Session lasts for the life of a project. A thread version is the combination of a workspace snapshot and a conversation-context head. Thread branches, restore, diff and merge operate on those two dimensions together.

It deliberately does not reproduce all of Git. There is no staging area, rebase, stash or per-tool revision, and there is no separate external-memory store. Durable project knowledge is carried by the versioned conversation context and its compaction state.

## Requirements

- Node.js 22.19 or newer
- Git 2.54 or a compatible build with `merge-tree --write-tree`
- A Git worktree

The harness depends on the published `@earendil-works/pi-ai` and `@earendil-works/pi-tui` packages from npm and does not depend on pi-agent-core or pi-coding-agent.

```powershell
npm install
npm run build
npm link
```

## Terminal interface

An interactive TTY starts in fullscreen mode. The main screen keeps the conversation, active tools and a fixed editor/footer together; `/thread diff`, `/thread merge` and `/thread history` open temporary screens that are never appended to the Project Session conversation. `/model` inspects or switches the runtime model, `/new` starts with empty conversation context while retaining the current workspace, `/clear` only hides the transcript rendered in the current terminal process, and `/compact` forces bounded runtime context compaction.

User and assistant messages are rendered with `pi-tui`'s width-aware Markdown component. Headings, emphasis, inline and fenced code, quotes, lists, links and tables receive terminal-native layout and semantic colors; long prose is capped to a readable width while command documents remain plain text.

```powershell
thread --tui fullscreen   # default for an interactive terminal
thread --tui regular      # preserve native terminal scrollback
thread --tui plain        # readline/text output
```

Non-TTY input or output automatically selects plain mode. In fullscreen views, use arrow keys or `j/k` to scroll and `Esc` to return. `Ctrl+C` interrupts active work; press it twice while idle to exit. The editor supports multiline input, bracketed paste, path completion and IME positioning through pi-tui.

## Run

After the one-time `npm link`, launch the harness from the project you want to work on. The current directory is resolved to its containing Git worktree root:

```powershell
Set-Location D:\path\to\a\git-worktree
thread
```

User model configuration is global and is never read from or written to the project worktree. Its default location is `~/.thread/config.json` (`%USERPROFILE%\.thread\config.json` on Windows):

```powershell
New-Item -ItemType Directory -Force "$HOME\.thread"
Copy-Item D:\WORK\projects\thread\thread.config.example.json "$HOME\.thread\config.json"
$env:MY_RELAY_API_KEY = "<secret>"
thread
```

Set `THREAD_HOME` to relocate the whole user configuration directory. Use `--config <path>` or `THREAD_CONFIG` to select a different file. API keys are intentionally referenced by `apiKeyEnv`; do not put secrets in the JSON file.

If the thread config file does not exist, the harness falls back to pi's existing global configuration:

```text
~/.pi/agent/models.json       provider and model definitions
~/.pi/agent/settings.json     defaultProvider and defaultModel
```

`PI_CODING_AGENT_DIR` is honored when pi uses a non-default directory. This is a fallback, not a merge: once `~/.thread/config.json` exists (or an explicit `--config` is supplied), pi configuration is not loaded. A missing explicit config is an error. Pi `apiKey` literals, environment templates such as `$KEY`/`${KEY}`, and `!command` values are resolved without copying secrets into the Project Session.

```json
{
  "model": { "provider": "my-relay", "id": "claude-sonnet-4-6" },
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

Supported custom APIs in v1 are `anthropic-messages`, `openai-completions`, and `openai-responses`. `contextWindow` is required because the harness uses it to decide when to compact; set it to the relay model's real limit. Optional provider `headers`, model `samplingParams`, and pi-ai `compat` overrides are also accepted.

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

The version commands remain usable without any configured model:

```powershell
thread
```

Normal text enters the streaming multi-step agent loop. `/model`, `/new`, `/clear`, `/compact`, `/thread ...` and `/rewind ...` are intercepted before the LLM and never become ordinary user messages.

## Model switching

The active model can be inspected or changed without restarting `thread`:

```text
/model
/model list
/model list <provider>
/model <provider>/<model>
/model <provider> <model>
```

In the fullscreen or regular TUI, selecting `model` from slash-command completion and pressing Enter immediately opens a second model list. The current model is marked with `●`; use ↑/↓ (or `j`/`k`) to move, Enter to switch, and Esc to cancel. Long catalogs stay centered around the selected row. Plain mode keeps `/model` as a status command and supports the explicit list/switch forms above.

The catalog contains pi-ai's built-in models plus custom providers loaded from the active thread or pi configuration. A switch retains the current conversation and workspace, while rebuilding the main agent loop, compactor, Context Capsule, semantic diff and context-merge services around the selected model. The TUI model label and context-window percentage update immediately.

`/model` changes only the running process. It does not edit the global configuration or append a message/checkpoint, so a restart again uses `--provider`/`--model`, `THREAD_PROVIDER`/`THREAD_MODEL`, or the configured default in normal precedence order.

## Web tools

The built-in `websearch` tool searches through Exa's MCP endpoint by default. Set `THREAD_WEBSEARCH_PROVIDER=parallel` to use Parallel instead; `exa` is the other accepted value. `EXA_API_KEY` and `PARALLEL_API_KEY` add provider credentials when present, while both integrations may still be attempted without a key according to the provider's own access policy. Search accepts one query, an optional result count (maximum 20), live-crawl preference, search depth and context-size bound.

The built-in `webfetch` tool retrieves one HTTP(S) URL as Markdown, plain text or HTML. It has a 30-second default timeout (120-second maximum), rejects responses larger than 5 MiB and limits model-visible converted output to 200,000 characters. Binary responses are rejected. Both web tools are recorded as non-replayable so interrupted requests are never automatically issued again.

`webfetch` follows HTTP redirects and does not currently block private, loopback or link-local destinations. The harness also has no web-specific approval policy, so do not expose it to an untrusted model in an environment where HTTP access can reach sensitive internal services.

## Version commands

```text
/new
/clear
/compact
/model [list [<provider>] | <provider>/<model> | <provider> <model>]
/thread status
/thread branches
/thread branch <name> [<from>]
/thread switch <branch>
/thread log [<branch>] [--graph|--all]
/thread reflog [<branch>]
/thread show <ref>
/thread history
/thread commit <message>
/thread diff <from> <to> [--facts]
/thread restore <ref> [--workspace|--context|--both]
/thread merge <ref> [--context=keep-current|summarize]
/rewind <turn-id-or-user-entry-id>
```

`/new` creates a checkpoint whose workspace is unchanged and whose conversation-context head is empty. The previous context, including any compacted project state, remains reachable through the checkpoint history. `/clear` changes no durable state: it hides messages through the current context head, while later messages continue to use the complete backend context. Restarting the terminal or navigating to another context may show those messages again.

`/compact` forces runtime context compaction without adding a user message. The post-compaction input target is 7% of the model context window, including the system prompt, tools, extension context, generated project state and retained raw interactions. Before summarization, messages are projected to dated, text-only semantic evidence: provider metadata, usage, thinking, signatures, binary image data and raw tool details are excluded while each message's `YYYY-MM-DD` source date, user-visible text, tool calls, model-visible tool results and material stop/error state remain. The final project state has a 4K-token ceiling and serves two purposes: it selectively carries only durable project knowledge likely to help future work, and it keeps a rolling digest of the most recently compressed conversation, including what the user discussed or requested. Time-sensitive or superseding state may retain its absolute date; timeless facts are not mechanically dated. On the first compaction the state is created from the older interaction prefix. Later compactions explicitly reconcile the previous state with only the newly compacted interactions: useful valid project knowledge is retained, later corrections replace older state, stale or irrelevant state is removed, and the previous recent-conversation digest is replaced rather than accumulated indefinitely. Within the remaining tail budget the compactor retains as many recent complete user-led interactions as fit, with a minimum of two. If those two interactions already exceed the target they remain intact, so 7% is a target rather than a destructive hard limit. It creates an internal checkpoint so the branch context head remains recoverable and is not an `/thread commit`. If there is no older interaction to absorb, it is a no-op.

`HEAD`, thread branch names, full IDs and unambiguous commit/checkpoint ID prefixes are valid refs. Thread branches are independent of the main repository's Git branches: switching a thread branch never moves the main Git HEAD, index, refs or reflog.

`diff --facts` is deterministic and does not call a model. Normal `diff` adds a separately invoked semantic explanation and falls back to facts if that call fails. Semantic diff output is ephemeral and does not enter the main transcript.

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
├── indexes/<session-id>        private Git index
├── sessions/<session-id>/
│   ├── events.jsonl            canonical append-only Project Session log
│   ├── session.json
│   └── cache/                   rebuildable capsules and semantic diffs
├── locks/
└── tmp/
```

The JSONL log is replayed into an in-process projection at startup. A partial final line is discarded; corruption in the middle stops recovery. State changes that must appear together are written as one batch record. `tool_started` for a `replay=never` tool is flushed before the side effect, and startup recovery never blindly executes it again.

Workspace objects are fully owned by the independent sidecar. Its chronological retention commits only keep objects reachable; Checkpoint DAG ancestry comes from `events.jsonl`. Startup reconciliation repairs a keep ref that lags the latest durable checkpoint.

Snapshots cover main-repository tracked files and non-ignored untracked files. They exclude ignored files, empty directories, submodule internals, paths outside the worktree, processes, databases, network effects and other external side effects. Restore creates a safety checkpoint and refuses ignored/out-of-scope collisions. Gitlink metadata is preserved in trees, while submodule internals are intentionally not restored.

## Context and compaction

Raw session entries are append-only. Runtime compaction appends an updated project state plus retained tail instead of deleting earlier entries. Automatic compaction uses the estimated complete request after system prompt, tools and extension context changes, and reserves the same explicit output budget used for the model call plus pi-ai's safety margin. Oversized new interaction input is reduced through bounded chronological chunks before it is applied to the previous project state. Context Capsules are bounded, lossy caches attached to checkpoints; explicit commits try to create one eagerly, while semantic diff/merge creates missing capsules lazily. Compaction and Capsules share the same deterministic semantic message projection so derived summaries do not ingest provider bookkeeping, hidden thinking or duplicate raw tool details.

There is no separate project-memory service, retrieval projection or built-in memory tool. Long-term project knowledge must survive through the compacted conversation state, so it follows the same branch, checkpoint, restore, diff and merge boundaries as the rest of the session context.

## Extensions

Trusted local extensions can register tools, `/thread` commands and five events: `turn_start`, `before_context`, `before_tool_call`, `tool_result` and `turn_end`.

```powershell
npm start -- --root D:\path\to\repo --extension .\examples\extension.mjs
```

See [examples/extension.mjs](examples/extension.mjs). Core tool and command names are reserved; duplicate registration fails.

## Public API

`ThreadApp.open()` can be embedded with an injected `ModelClient`, which is also how the faux provider is used for the minimal end-to-end smoke. `app.fsck()` checks log projections and sidecar objects. `app.deleteProjectSession()` explicitly deletes this harness's session log, private index and keep ref, then runs sidecar GC; it does not delete the main worktree.

## Verification policy

This project intentionally avoids a broad test matrix. The retained checks cover only sidecar self-containment/restore, interrupted non-replayable tools, clean/conflicting merge safety and one end-to-end Project Session version loop.
