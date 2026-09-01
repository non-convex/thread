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
- 通过 `~/.thread/config.json`、兼容的 pi fallback，或 `--provider` 与 `--model` 配置模型

Thread 不要求 Git，任意已有目录都可以作为项目打开。

```bash
bun install
bun run dev --root /path/to/project
```

交互式 TTY 默认进入全屏终端；非 TTY 自动使用 plain 模式，也可用 `--tui plain` 强制指定。

## 核心语义

### Session

一个项目只有一棵 Session Tree，树上有一个虚拟 Root。所有顶层 Session 都直接从 Root 创建。

`/new` 创建并激活空 Session，项目文件保持不变；它不复制消息、不生成摘要、不调用模型，也不恢复文件。`/session` 列出 Session，`/session <id>` 在保存的 live tip 上继续旧 Session，同样不改变工作区。

模型默认只看到活动 Session 的当前路径。其他 Session 与 rewind 后保留的旧路径仍是项目记忆，可通过 `session_search` 和 `session_read` 按需召回。

### Turn 与工作区状态

一个 turn 保存用户消息、assistant 消息、工具执行事实、工具结果、结束状态、父 turn 和工作区状态 ID。执行顺序固定为：

```text
立即显示用户消息，并创建仅驻留运行时的 planned turn
→ 工作区扫描与首次模型请求并行
→ state ID 就绪后，将 planned identity 绑定为正式 running turn
→ 在后台写入工作区状态和 Session Tree
→ 任何工具副作用前，确保工作区状态和工具开始事实已可靠落盘
→ 可靠提交 turn 结束状态并推进 Session live tip
```

失败或中断的 turn 会保留在历史中，但不会推进 live tip。启动时遗留的 running turn 会被标记为 `interrupted`，已开始的工具绝不会自动重跑。

TUI 会立即投影刚提交的用户消息。planned turn 只存在于运行时，用来让首次模型请求与工作区扫描重叠；只有内容寻址的 workspace state ID 就绪后，它才成为 Session Tree 中的事实 Turn。随后记录同步进入内存投影，再由单一有序队列在后台写盘；工具执行和 turn 最终完成仍是必须等待的 durability barrier。

工作区状态使用内容寻址的 manifest 与 blob，位于 `~/.thread/projects/<project-id>/workspace-states`。默认包含 ignored 文件和空目录；排除 `.git`、`.thread`、Thread 自身状态目录、项目外路径、进程、数据库、网络副作用及其他外部状态。嵌入方可通过 `ThreadAppOptions.workspaceExcludedPaths` 增加项目相对排除项。

### Rewind

`/rewind` 只列出活动 live path 上的用户 turn。选择某个 turn 等价于“回到这条用户消息尚未执行的时刻”：

1. 校验并恢复该 turn 的工作区状态；
2. 将当前 Session 的 live tip 移到该 turn 的父 turn；
3. 失效旧路径对应的派生上下文压缩；
4. 所选 turn 及其后续历史继续保存在 Session Tree 中。

下一条用户消息会自然产生新的子路径。工作区状态缺失或损坏时，rewind 会在移动 live tip 之前明确失败。

### Context compaction

Compaction 是可删除缓存，不是历史节点。`/compact` 摘要较早的路径前缀，并逐字保留最近 turn。模型窗口达到 78%，或 provider 报告 overflow 时，也会使用同一缓存机制。

删除 compaction cache 不会删除或改写 Session、Turn 或 Entry，完整上下文仍可由 Session Tree 重建。

## 命令

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
  cache/compaction/
workspace-states/
  states/
  blobs/
```

Session Tree 使用只追加 JSONL。Projection、搜索结果、标题、token 统计和 compaction summary 都是派生数据。运行时只接受当前 `thread-project-v1`、`thread-session-tree-v1` 与 `thread-workspace-state-v1` 格式；旧数据不读取、不迁移、不升级，也不会被部分解释。

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
src/context/          live-path 输入、预算与 compaction cache
src/agent/            模型/工具 turn runtime 与中断处理
src/app/              composition 与应用用例
src/commands/         命令接口
src/ui/               plain 与全屏界面
```

## License

MIT，见 `LICENSE`。
