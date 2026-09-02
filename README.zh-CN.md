# thread

`thread` 是一个 coding-agent runtime：每个项目只有一棵持久化 **Session Tree**，并提供以用户 turn 为单位的安全 `/rewind`。

项目目录是真实磁盘状态；对话历史是一棵只追加的树。每个用户 turn 开始前，Thread 都会捕获受管理的工作区，让用户以后能精确回到该消息执行前。

```text
Project
├── Current workspace
└── Persistent Session Tree
    ├── Root
    ├── Session A: Turn 1 → Turn 2 → Turn 3
    │                            └────→ rewind 后的 Turn 3′
    └── Session B: /new 创建的独立空上下文
```

Thread 不实现自己的通用版本控制。项目若使用 Git，它也只是 agent 可以调用的一种外部工具。

## 环境与启动

- Bun 1.3 或更高版本
- 通过 `~/.thread/config.json`、兼容的 pi fallback、`--provider` 与 `--model`，或 ChatGPT 订阅登录配置模型

Thread 不要求 Git，任意已有目录都可以作为项目打开。

```bash
bun install
bun run dev --root /path/to/project
```

交互式 TTY 默认进入全屏终端；非 TTY 自动使用 plain 模式，也可用 `--tui plain` 强制指定。

### ChatGPT 订阅

Thread 可以通过内置的 `openai-codex` OAuth provider 使用 ChatGPT 订阅包含的 Codex 权益。登录凭据由 Thread 独立持有，不与 Codex CLI 的凭据文件混用：

```bash
thread login openai-codex
thread auth status
thread --provider openai-codex --model gpt-5.6-terra
```

首次登录成功后，`openai-codex` 模型会进入正常的 `/model` 选择器，OAuth token 也会自动刷新。凭据保存在 `~/.thread/auth.json`（或 `$THREAD_HOME/auth.json`），应按密码文件保护。退出登录：

```bash
thread logout openai-codex
```

## 核心语义

### Session

一个项目只有一棵 Session Tree，树上有一个虚拟 Root。所有顶层 Session 都直接从 Root 创建。

`/new` 创建并激活空 Session，项目文件保持不变；它不复制消息、不生成摘要、不调用模型，也不恢复文件。`/session` 列出 Session，`/session <id>` 在保存的 live tip 上继续旧 Session，同样不改变工作区。

模型默认只看到活动 Session 的当前路径。其他 Session 与 rewind 后保留的旧路径仍是项目记忆，可通过 `session_search` 和 `session_read` 按需召回。

### Turn 与工作区状态

一个 turn 保存用户消息、assistant 消息、工具执行事实、工具结果、结束状态、父 turn 和工作区状态 ID。该 ID 是上一轮保存的检查点：上一 turn 结束时的快照，或本进程第一个 turn 的一次性启动扫描。执行顺序固定为：

```text
立即显示用户消息，并创建仅驻留运行时的 planned turn
→ 复用上一检查点（尚不存在时才扫描）并与首次模型请求并行
→ state ID 就绪后，将 planned identity 绑定为正式 running turn
→ 在后台写入 Session Tree
→ 任何工具副作用前，确保工作区状态和工具开始事实已可靠落盘
→ 可靠提交 turn 结束状态，扫描新检查点，并推进 Session live tip
```

失败或中断的 turn 会保留在历史中，但不会推进 live tip。启动时遗留的 running turn 会被标记为 `interrupted`，已开始的工具绝不会自动重跑。

工具调度同时考虑 effect 和资源冲突。只读 effect 在完整 tool call 流出且工具开始事实可靠落盘后即可启动；写入、进程和交互 effect 会等待完整 assistant 响应可靠落盘。资源互不冲突时并行执行，读写资源重叠或工具明确声明 sequential 时则保持 assistant 源顺序。完成事件按真实完成顺序发出，tool-result 消息仍按 assistant 源顺序提交；全部完成后才发起下一次模型请求。

TUI 会立即投影刚提交的用户消息。planned turn 只存在于运行时，用来让首次模型请求与检查点解析重叠；workspace state ID 就绪后，它才成为 Session Tree 中的事实 Turn。随后记录同步进入内存投影，再由单一有序队列在后台写盘；工具执行和 turn 最终完成仍是必须等待的 durability barrier。turn 结束时的扫描是下一轮发送要保存的检查点；blob 落盘可以在后台完成。

工作区状态使用内容寻址的 manifest 与 blob，位于 `~/.thread/projects/<project-id>/workspace-states`。默认包含 ignored 文件和空目录；排除 `.git`、`.thread`、Thread 自身状态目录、项目外路径、进程、数据库、网络副作用及其他外部状态。嵌入方可通过 `ThreadAppOptions.workspaceExcludedPaths` 增加项目相对排除项。

### Rewind

`/rewind` 只列出活动 live path 上的用户 turn。选择某个 turn 等价于“恢复该 turn 开始前保存的检查点”：也就是上一 turn 结束时的快照，不包含那次快照之后、发送之前的手工修改。本进程的第一个 turn 仍在发送时做一次启动扫描。

1. 校验并恢复该 turn 的工作区状态；
2. 将当前 Session 的 live tip 移到该 turn 的父 turn；
3. 从新路径重新构建 live context，旧路径上的 compaction entry 会自然退出；
4. 所选 turn 及其后续历史继续保存在 Session Tree 中。

下一条用户消息会自然产生新的子路径。工作区状态缺失或损坏时，rewind 会在移动 live tip 之前明确失败。

### Context compaction

Compaction 是追加写入 Session Tree 的一种 entry，保存摘要、逐字保留的完整 turn 后缀、压缩前 token 估算和触发原因。`/compact` 会把它追加到当前 live tip；模型窗口达到 78%，或 provider 报告 overflow 时，也会追加同一种 entry。

生成摘要前，Thread 会先估算实际的 system/tool 开销，并固定为摘要预留 4K token；然后在 `system + summary + retained turns ≈ 20K` 的预算内，从最新 turn 向前保留尽可能多的完整 turn，同时无论是否超预算都至少保留最近两个 turn。每次模型请求都会重新遍历当前路径的 entries 来构建 live context。路径存在 compaction 时，只投影最新一条，形成 `summary + retained turns + 该 entry 之后追加的消息`。更早的原始 entry 不会被删除或改写，因此 rewind、分支、历史和搜索仍使用完整 Session Tree。

## 命令

顶层认证命令：

```text
thread login <provider>
thread logout <provider>
thread auth status
```

交互式命令：

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

旧版的通用版本管理命令有意不再识别。

## 项目记忆工具

- `session_search` 搜索整棵 Session Tree，包括其他 Session 和 rewind 后保留的历史路径；结果标明 Session、turn、时间、状态和路径关系。
- `session_read` 读取一个命中 turn，或它附近一段有界的连续路径；默认只返回叙事文本，thinking、工具调用和工具结果需显式开启。

历史信息可能相对当前工作区已经过时，因此涉及正确性时，agent 会重新检查文件。

## 持久化与兼容性

项目身份只依赖规范化项目路径，不依赖仓库或 worktree。新格式数据位于 `~/.thread/projects/<project-id>`（或 `$THREAD_HOME/projects/<project-id>`）：

```text
project.json
session-tree/
  tree.json
  events.jsonl
workspace-states/
  states/
  blobs/
```

Session Tree 使用只追加 JSONL，消息、工具事实、turn、live-tip 变化和 compaction entry 都持久化在其中；Projection、搜索结果、标题和 token 统计可以据此重建。运行时只接受当前 `thread-project-v1`、`thread-session-tree-v1` 与 `thread-workspace-state-v1` 格式；旧数据不读取、不迁移、不升级，也不会被部分解释。

## 配置

默认模型配置为 `~/.thread/config.json`，示例见 `thread.config.example.json`。支持 `THREAD_HOME`、`THREAD_CONFIG`、`THREAD_PROVIDER` 和 `THREAD_MODEL`。最近使用的模型和 thinking level 会保存到 `~/.thread/state.json`，命令行显式选择优先。

Skills 在启动时加载一次，并进入稳定的 system-prompt 前缀。Extensions 可通过导出 API 注册工具、Session Tree 命令和运行时 hook。

## 开发

```bash
bun run check
bun test test --timeout 30000
bun run build
```

主要代码边界：

```text
src/project/          项目身份与生命周期
src/session-tree/     Session、Turn、Entry、路径、历史与搜索
src/workspace-state/  捕获、完整性校验与 rewind 恢复
src/context/          live-path 投影、预算与 compaction entry
src/agent/            模型/工具 turn runtime 与中断处理
src/app/              composition 与应用用例
src/commands/         命令接口
src/ui/               plain 与全屏界面
```

## License

MIT，见 `LICENSE`。
