<div align="center">

# Thread

**围绕持久化 Session Tree 构建、支持 turn 级工作区回退的 coding-agent runtime。**

[English](./README.md) · [Releases](https://github.com/non-convex/thread/releases) · [架构](#架构)

[![CI](https://github.com/non-convex/thread/actions/workflows/ci.yml/badge.svg)](https://github.com/non-convex/thread/actions/workflows/ci.yml)
[![Bun 1.3+](https://img.shields.io/badge/Bun-1.3%2B-f9f1e1?logo=bun)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

Thread 为每个项目维护一棵持久化对话树。它保留你走过的完整路径，可以在不改动文件的情况下开启独立 Session，也可以把工作区精确恢复到某条用户消息执行之前。

项目目录仍是普通磁盘状态，Git 也仍然只负责 Git 的事情。Thread 在它们之外增加一份只追加的 agent 工作记录，以及内容寻址的工作区检查点。

```text
Project
├── Current workspace
└── Persistent Session Tree
    ├── Root
    ├── Session A: Turn 1 → Turn 2 → Turn 3
    │                            └────→ rewind 后的 Turn 3′
    └── Session B: /new 创建的独立空上下文
```

## 界面展示

![Thread 欢迎界面](docs/assets/thread-welcome.png)

<p align="center"><em>全屏 TUI 直接打开当前项目的持久化 Session Tree。</em></p>

![Thread 执行编码任务](docs/assets/thread-session.png)

<p align="center"><em>在一个界面中查看流式思考、工具活动、耗时、上下文用量、模型和 thinking level。</em></p>

## 为什么是 Thread

| 需求 | Thread 的做法 |
| --- | --- |
| 隔天继续项目工作 | 按项目持久化 Session、turn、消息、工具事实和 live tip。 |
| 安全尝试另一条路线 | `/rewind` 恢复 turn 前的工作区，并从那里分叉，不删除旧路径。 |
| 从干净上下文开始 | `/new` 创建空的根 Session，但保持项目文件不变。 |
| 找回当前路径之外的工作 | Agent 可以搜索并读取其他 Session 和历史分支中的 turn。 |
| 支撑长任务 | 手动或自动压缩 live context，不重写 Session Tree。 |
| 并行处理边界清晰的实现工作 | 可选 worker 在共享工作区执行一到两个互不重叠的叶子任务。 |
| 接入不同模型后端 | 支持 ChatGPT 订阅登录，以及可配置的 OpenAI / Anthropic 兼容 provider。 |

Thread 不是版本控制替代品。它恢复的是受管理的工作区，而不是 commit、branch、进程、数据库、远程服务或其他外部副作用。

## 快速开始

### 环境要求

- 使用 [standalone release](https://github.com/non-convex/thread/releases)，或在从源码运行时准备 Bun 1.3+
- 已配置的模型 provider，或 ChatGPT 订阅登录
- 内置代码搜索工具需要 [ripgrep](https://github.com/BurntSushi/ripgrep)（`rg`）

不要求 Git，任何已有目录都可以作为项目打开。

### 使用发行版

下载对应平台的压缩包，解压后把 `thread`（Windows 为 `thread.exe`）加入 `PATH`：

```bash
thread --root /path/to/project
```

交互式 TTY 默认进入全屏界面；管道或重定向场景会自动使用 plain 模式，也可通过 `--tui plain` 强制指定。

### 从源码运行

```bash
git clone https://github.com/non-convex/thread.git
cd thread
bun install
bun run dev --root /path/to/project
```

后文示例默认使用发行版命令；从源码运行时，把命令开头的 `thread` 替换为 `bun run dev`。

### 连接模型

ChatGPT 订阅用户最快可以使用内置的 `openai-codex` OAuth provider：

```bash
thread login openai-codex
thread auth status
thread --root /path/to/project
```

进入 TUI 后运行 `/model all` 选择可用模型，也可以在启动时直接指定：

```bash
thread --root /path/to/project --provider openai-codex --model <model-id>
```

这份登录由 Thread 独立持有，不与 Codex CLI 共用凭据文件。凭据保存在 `~/.thread/auth.json`（或 `$THREAD_HOME/auth.json`），应按密码文件保护。使用 `thread logout openai-codex` 可以删除登录信息。

如果使用 API key 或兼容中转服务，把 [`thread.config.example.json`](./thread.config.example.json) 复制到 `~/.thread/config.json`，修改 provider 与 model，然后设置 `apiKeyEnv` 指定的环境变量。自定义 provider 支持：

- `openai-responses`
- `openai-completions`
- `anthropic-messages`

## 核心概念

### 一个项目，一棵 Session Tree

项目身份只取决于规范化后的项目路径。每个项目只有一个虚拟 Root，可以拥有任意数量的顶层 Session。

- `/new` 创建并激活空 Session；它不复制消息、不调用模型、不总结历史，也不修改文件。
- `/session` 列出所有 Session。
- `/session <id>` 从某个 Session 保存的 live tip 继续，但不改变当前工作区。

模型默认只看到活动 Session 的当前路径。历史分支和其他 Session 仍会作为项目记忆保留，agent 可以通过 `session_search` 和 `session_read` 搜索、读取；当正确性依赖这些可能过时的证据时，agent 会被要求重新核对当前文件。

### Turn 与工作区检查点

每个 turn 保存用户消息、assistant 输出、工具调用与结果、父 turn、结束状态和 workspace-state ID。这个 workspace state 表示用户 turn 开始前的检查点。

Turn 结束时，Thread 会捕获供下一次发送使用的新检查点；后续 turn 直接复用它，只有进程中的第一个 turn 需要做启动扫描。这样首次模型请求可以与检查点解析重叠，同时所有工具副作用之前仍存在可靠的 turn 前边界。

失败或中断的 turn 会被补成合法对话前缀，并继续作为 live tip。重启时，仍标记为 running 的 turn 也会按相同方式封口；已经启动过的工具绝不会自动重放。

### Rewind 不会抹掉历史

`/rewind` 只展示当前 live path 上的用户 turn。选择一个 turn 后，Thread 会依次：

1. 校验并恢复该 turn 开始前保存的检查点；
2. 把 Session live tip 移到它的父 turn；
3. 从新的 live path 重建模型上下文；
4. 在 Session Tree 中保留所选 turn 及其全部后续历史。

你的下一条消息会自然生成新分支。如果检查点缺失或损坏，rewind 会在移动 live tip 之前失败。

需要注意一个精确边界：检查点来自上一个已完成 turn。Thread 空闲期间、检查点生成之后、下一次发送之前发生的手工修改，不属于下一 turn 的“turn 前状态”。

### Context compaction

Compaction 是另一种只追加的 Session Tree entry，不会重写历史。它保存滚动的项目状态摘要、保留的完整模型 step，以及切点落在 turn 内部时使用的独立进度 checkpoint。

- `/compact` 手动请求一次压缩。
- 上下文达到 78%，或 provider 报告 overflow 时，会在完整 model-step 边界自动压缩。
- 每次至少保留最新五个完整 step，并在约 20K token 的工作集预算允许时向前扩展。
- 更早的 turn 仍然可用于 rewind、history、search 和 `session_read`。

### 可选 implementation worker

Subagent 默认关闭。运行 `/subagent`，选择 **On**，再显式选择 worker model。主 agent 随后可以把一到两个写入范围互不重叠的独立叶子任务委派出去。

Worker 直接编辑同一项目目录，不存在私有副本或 apply 步骤。`writeScope` 是协调边界，不是文件系统沙箱。主 agent 仍负责检查当前文件、运行测试，并可以在同一 worker 上下文中请求返工。

Worker 只属于创建它的父 turn。Turn 结束或中断、Thread 关闭或重启，都会取消未完成任务，同时保留已经写入的文件。需要恢复整个工作区时使用 `/rewind`。完整设计见 [Subagent 架构](./docs/subagent-architecture.md)。

## 命令

### 认证命令

| 命令 | 用途 |
| --- | --- |
| `thread login <provider>` | 启动受支持的订阅登录。 |
| `thread logout <provider>` | 删除 provider 凭据。 |
| `thread auth status` | 查看订阅认证状态。 |

### 交互命令

| 命令 | 用途 |
| --- | --- |
| `/new` | 从 Root 创建空 Session，保持工作区文件不变。 |
| `/session [<session-id>]` | 列出 Session，或从保存的 tip 继续。 |
| `/rewind [<turn-id-or-user-entry-id>]` | 选择或直接恢复 turn 前检查点。 |
| `/compact` | 压缩活动路径的 live model context。 |
| `/model [all\|list [provider]\|<provider>/<model>]` | 查看或切换主模型。 |
| `/subagent [off\|on [all]\|<provider>/<model>]` | 配置 implementation worker。 |
| `/skill [<name> [extra instruction]]` | 列出或调用已加载 skill。 |
| `/thread status` | 查看项目和活动 Session Tree 状态。 |
| `/thread sessions` | 列出根 Session 与保存的 live tip。 |
| `/thread open <session-id>` | 恢复 Session，不改变文件。 |
| `/thread history` | 浏览整棵项目树中的 turn。 |
| `/thread search <query> [<query> ...]` | 搜索所有 Session 和历史路径。 |
| `/clear` | 只清空当前可见 transcript。 |
| `/exit` | 退出 Thread。 |

全屏 TUI 中，`Shift+Tab` 循环切换模型支持的 thinking level，`Esc` 中断当前 turn。

## 配置与状态

Thread 默认读取 `~/.thread/config.json`。如果该文件不存在，会回退到 `~/.pi/agent` 下兼容的 provider 与默认模型配置。

模型选择优先级为：

```text
--provider/--model 或 THREAD_PROVIDER/THREAD_MODEL
→ ~/.thread/state.json 中记住的交互式选择
→ ~/.thread/config.json 中的 model
```

常用环境变量：

| 变量 | 用途 |
| --- | --- |
| `THREAD_HOME` | 修改状态目录，默认为 `~/.thread`。 |
| `THREAD_CONFIG` | 使用其他配置文件。 |
| `THREAD_PROVIDER` | 选择主 provider，需要与 `THREAD_MODEL` 同时使用。 |
| `THREAD_MODEL` | 选择主模型，需要与 `THREAD_PROVIDER` 同时使用。 |

Thinking level、主模型选择、subagent 开关和 worker model 会保存在 `~/.thread/state.json`。Skills 在启动时加载一次。Extensions 可以通过导出 API 注册工具、Session Tree 命令和 runtime hook。

## 持久化与安全边界

项目状态保存在工作区之外的 `~/.thread/projects/<project-id>`：

```text
project.json
session-tree/
  tree.json
  events.jsonl
workspace-states/
  states/
  blobs/
agent-tasks/
  events.jsonl
```

Session Tree 与 Agent Task 分别使用独立的只追加 JSONL 事件流。Workspace state 由内容寻址的 manifest 和 blob 组成，并记录空目录。

检查点不会简单套用 `.gitignore`，但会在任意层级排除 Thread 元数据和常见生成目录，例如 `.git`、`.thread`、`node_modules`、`dist`、`build`、`coverage`、`target`、虚拟环境和常见框架缓存。嵌入方可以通过 `ThreadAppOptions.workspaceExcludedPaths` 增加项目相对排除项。

项目外路径、排除目录、进程、数据库、网络副作用和其他外部状态永远不会被 `/rewind` 恢复。

Loader 只接受当前的 `thread-project-v1`、`thread-session-tree-v1`、`thread-workspace-state-v2` 和 `thread-agent-task-v2` 格式。旧数据不会被静默迁移，也不会被部分解释。

## 执行模型

工具调度同时考虑 effect 和资源冲突：

- 只读 effect 在完整流式 tool call 与工具开始事实可靠落盘后即可启动。
- 写入、进程和交互 effect 会等待完整 assistant 响应可靠落盘。
- 资源互不冲突时可以并行；读写范围重叠时保持 assistant 源顺序。
- 完成事件按真实完成顺序出现，tool-result 消息仍按 assistant 源顺序提交，之后才会开始下一次模型请求。

因此 TUI 可以尽早展示进度并保持响应，同时不削弱副作用之前的持久化边界。

## 架构

```text
src/project/          项目身份与生命周期
src/session-tree/     Session、Turn、Entry、路径、历史与搜索
src/workspace-state/  检查点捕获、校验、恢复与 GC
src/context/          live-path 投影、预算与 compaction
src/agent/            模型 step、journal、调度与 turn runtime
src/agent-task/       共享工作区 worker 生命周期与任务 journal
src/app/              runtime 组装、输入路由与 use case
src/commands/         Session Tree 命令接口
src/tools/            内置 agent 工具与执行策略
src/ui/               plain 与全屏终端界面
```

Thread 也导出了 runtime、store、model catalog、tool、command、skills loader、extension API 和 UI 类型，便于嵌入其他应用。公共接口见 [`src/index.ts`](./src/index.ts)。

延伸阅读：

- [Subagent 架构](./docs/subagent-architecture.md)
- [给模型用的 grep](./docs/grep.md)

## 开发

```bash
bun run check
bun test test --timeout 30000
bun run build
```

CI 会执行类型检查、测试、生产构建和 CLI smoke test。带 tag 的 release 会为 Windows、Linux 与 macOS 编译 x64 / ARM64 standalone binary。

## License

[MIT](./LICENSE)
