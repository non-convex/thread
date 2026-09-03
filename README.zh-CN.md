<div align="center">

# Thread

**Thread 让 coding agent 记住整个项目，随时接续、回溯并推进工作。**

[English](./README.md) · [Releases](https://github.com/non-convex/thread/releases) · [开发](#开发)

[![CI](https://github.com/non-convex/thread/actions/workflows/ci.yml/badge.svg)](https://github.com/non-convex/thread/actions/workflows/ci.yml)
[![Bun 1.3+](https://img.shields.io/badge/Bun-1.3%2B-f9f1e1?logo=bun)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

项目内，Thread 用一棵持久化 Session Tree 记录与 agent 的全部交互和执行轨迹，让项目历史成为可搜索、可召回的项目记忆，整棵树的全局感知仍待实现；项目外，跨项目全局记忆与 **Dreamer** 机制正在开发。实现遵循三点：保持精简，如无必要勿增实体；精心管理和压缩上下文，尽量维持缓存命中；只让确实需要的信息进入上下文，避免窗口过快膨胀，更细粒度的准入机制仍待实现。

## 界面

![Thread 欢迎界面](docs/assets/thread-welcome.png)

<p align="center"><em>打开项目，直接进入它的持久化 Session Tree。</em></p>

![Thread 执行编码任务](docs/assets/thread-session.png)

<p align="center"><em>在一个界面中查看思考、工具活动、耗时、上下文用量、模型和 thinking level。</em></p>

## 快速开始

### 环境要求

- 使用 [standalone release](https://github.com/non-convex/thread/releases)，或从源码运行时准备 Bun 1.3+
- 模型 provider 或 ChatGPT 订阅登录
- 内置代码搜索工具需要 [ripgrep](https://github.com/BurntSushi/ripgrep)（`rg`）

不要求 Git，Thread 可以把任意已有目录作为项目打开。

### 使用发行版

下载对应平台的压缩包，解压后把 `thread`（Windows 为 `thread.exe`）加入 `PATH`：

```bash
thread --root /path/to/project
```

使用 `--tui plain` 可以强制进入 plain 模式。

### 从源码运行

```bash
git clone https://github.com/non-convex/thread.git
cd thread
bun install
bun run dev --root /path/to/project
```

后文示例默认使用发行版命令；从源码运行时，把开头的 `thread` 替换为 `bun run dev`。

### 连接模型

ChatGPT 订阅用户可以使用内置的 `openai-codex` OAuth provider：

```bash
thread login openai-codex
thread auth status
thread --root /path/to/project
```

进入 TUI 后运行 `/agent main model all` 选择可用模型，也可以在启动时直接指定：

```bash
thread --root /path/to/project --provider openai-codex --model <model-id>
```

Thread 与 Codex CLI 不共用凭据文件；登录信息保存在 `~/.thread/auth.json`（或 `$THREAD_HOME/auth.json`），应按密码文件保护。使用 `thread logout openai-codex` 可以删除登录信息。

如果使用 API key 或兼容中转服务，把 [`thread.config.example.json`](./thread.config.example.json) 复制到 `~/.thread/config.json`，修改 provider 与 model，再设置 `apiKeyEnv` 指定的环境变量。自定义 provider 支持 `openai-responses`、`openai-completions` 和 `anthropic-messages`。

## 工作原理

### Session 是同一份历史中的不同路径

一个项目只有一个虚拟 Root，可以拥有任意数量的顶层 Session。Session 不是工作区副本，而是项目历史中的一条独立路径。

```text
Project
├── Current workspace
└── Persistent Session Tree
    ├── Session A: Turn 1 → Turn 2 → Turn 3
    │                            └────→ rewind 后的 Turn 3′
    └── Session B: /new 创建的独立上下文
```

- `/new` 创建并激活空 Session；它不复制消息、不调用模型、不总结历史，也不修改文件。
- `/session` 列出 Session。
- `/session <id>` 从保存的 live tip 继续，同样不改变文件。

模型默认只看到活动 Session 的 live path，其他内容继续留在项目记忆中，需要时再召回。

### Turn 连接交互、执行与工作区状态

每个 turn 保存用户消息、assistant 输出、工具执行事实与结果、父 turn、结束状态和 workspace-state ID。这个 workspace state 是用户 turn 开始前的检查点。

Turn 结束时，Thread 捕获供下一次发送使用的新检查点；进程中的第一个 turn 会先做启动扫描。失败或中断的 turn 会被补成合法对话前缀并继续作为 live tip，让下一条请求从真实发生过的历史继续。

Worker 执行轨迹写入同一项目的 Agent Task journal，不会直接灌进父 agent 上下文。父 agent 只接收精简任务结果，并直接检查共享工作区。

### Rewind 产生分支

`/rewind` 列出 active live path 上的用户 turn。选择一个 turn 后，Thread 会：

1. 校验并恢复它的 turn 前工作区检查点；
2. 把 Session live tip 移到该 turn 的父节点；
3. 从新路径重建上下文；
4. 在历史中保留所选 turn 及其所有后续内容。

下一条消息会自然生成新的子路径。检查点缺失或损坏时，操作会在 live tip 移动之前失败。

检查点来自上一个已完成 turn。Thread 空闲期间、检查点生成之后发生的手工修改，不属于下一 turn 的“turn 前状态”。

### 搜索与召回

`session_search` 搜索所有 Session 和历史分支；`session_read` 读取一个命中 turn，或它附近的一段有界路径。召回的信息可能已经过时，因此正确性依赖它时，agent 会重新核对当前文件。

## 上下文策略

- 普通请求只包含 active live path；路径之外的历史通过显式召回按需进入。
- Skills 只在启动时加载一次，成为稳定的 system-prompt 前缀。
- `${THREAD_HOME}/.THREAD.md` 作为固定的 Session 全局记忆快照加载在 system prompt 之后；`/new` 会为新 Session 重新读取。
- Compaction 只发生在完整 model-step 边界，并作为新的 append-only tree entry 保存。
- 只有预计能显著缩减上下文时，才会执行 compaction。

`/compact` 手动请求一次压缩。上下文达到 78%，或 provider 报告 overflow 时会自动压缩。每次至少保留最新五个完整 step，并在约 20K token 工作集预算允许时向前扩展。更早的历史仍可用于 rewind、搜索和召回。

## Agent 与全局记忆

`/agent` 是模型选择和 Agent 设置的统一入口。Thread 内置 `main`、`implementation-worker` 与 `dreamer` 三个 Profile。两个次级 Agent 默认关闭，并且必须显式选择模型。

全局记忆的唯一持久状态是 `${THREAD_HOME}/.THREAD.md`。它不进入 Session Tree、搜索、rewind 或 compaction。只有用户当前消息明确包含稳定、跨项目仍有价值的信息时，Main 才可以额外修改这个精确文件。每个 Session 始终使用创建时绑定的快照；磁盘变更会在 `/new` 或重启后可见。

Dreamer 是可选的后台记忆整理 Agent。使用 `/agent dreamer model <provider>/<model>` 选择模型并启用。它会在成功压缩后，或累计十个已结束 turn 并空闲十分钟后审阅对话证据；仅拥有 `read`、`write`、`edit`，同一时间只运行一个实例，成功时保持静默。

## Implementation worker

Implementation worker 默认关闭。运行 `/agent implementation-worker model <provider>/<model>` 选择模型并启用。Main 随后可以委派一到两个 `writeScope` 互不重叠的独立叶子任务。

Worker 直接编辑当前项目，不存在私有副本或 apply 步骤；`writeScope` 是协调边界，不是文件系统沙箱。主 agent 负责检查文件与测试，也可以在同一 worker 上下文中要求返工。

Worker 只属于创建它的父 turn。Turn 结束或中断、Thread 关闭或重启，都会取消未完成任务，同时保留已经写入的文件。需要恢复整个工作区时使用 `/rewind`。完整说明见 [Subagent 架构](./docs/subagent-architecture.md)。

## 命令

| 命令 | 用途 |
| --- | --- |
| `thread login <provider>` | 启动受支持的订阅登录。 |
| `thread logout <provider>` | 删除 provider 凭据。 |
| `thread auth status` | 查看订阅认证状态。 |
| `/new` | 创建空 Session，保持工作区文件不变。 |
| `/session [<session-id>]` | 列出或恢复 Session。 |
| `/rewind [<turn-id-or-user-entry-id>]` | 选择或直接恢复 turn 前检查点。 |
| `/compact` | 压缩 active live context。 |
| `/agent` | 查看所有内置 Agent 的状态。 |
| `/agent <id> [on\|off]` | 打开设置或启停次级 Agent。 |
| `/agent <id> model [all\|list [provider]\|<provider>/<model>]` | 查看或选择 Agent 模型。 |
| `/skill [<name> [extra instruction]]` | 列出或调用已加载 skill。 |
| `/thread status` | 查看项目和活动树状态。 |
| `/thread sessions` | 列出 Session 与保存的 live tip。 |
| `/thread open <session-id>` | 恢复 Session，不改变文件。 |
| `/thread history` | 浏览整棵树中的 turn。 |
| `/thread search <query> [<query> ...]` | 搜索所有 Session 和分支。 |
| `/clear` | 清空当前可见 transcript。 |
| `/exit` | 退出 Thread。 |

全屏 TUI 中，`Shift+Tab` 循环切换模型支持的 thinking level，`Esc` 中断当前 turn。

## 配置与存储

Thread 默认读取 `~/.thread/config.json`；该文件不存在时，会回退到 `~/.pi/agent` 下的兼容设置。主模型选择优先级为：

```text
--provider/--model 或 THREAD_PROVIDER/THREAD_MODEL
→ ~/.thread/state.json 中记住的选择
→ ~/.thread/config.json 中的 model
```

`THREAD_HOME` 修改状态目录，`THREAD_CONFIG` 指定其他配置文件。主模型、thinking level 和次级 Agent 选择会保存在 `~/.thread/state.json`。

项目状态位于工作区之外：

```text
~/.thread/projects/<project-id>/
├── project.json
├── session-tree/{tree.json,events.jsonl}
├── workspace-states/{states,blobs}
└── agent-tasks/events.jsonl
```

Session Tree 与 Agent Task 分别使用独立的 append-only log，workspace state 使用内容寻址。检查点会排除 Thread 元数据和常见生成目录，例如 `.git`、`.thread`、`node_modules`、`dist`、`build`、`coverage`、`target`、虚拟环境和框架缓存。

`/rewind` 永远不会恢复排除路径、项目外路径、进程、数据库、网络副作用或其他外部状态。Thread 不实现通用版本控制。

## 开发

```bash
bun run check
bun test test --timeout 30000
bun run build
```

主要代码边界：

```text
src/session-tree/     持久化项目历史、路径、搜索与召回
src/workspace-state/  检查点捕获、校验、恢复与 GC
src/context/          live-path 投影与 compaction
src/agent/            模型 step、工具调度、journal 与 turn
src/agent-task/       共享工作区 worker 生命周期与任务 journal
src/dreamer/          后台全局记忆整理与调度
src/app/              runtime 组装与输入路由
src/tools/            内置 agent 工具与执行策略
src/ui/               plain 与全屏终端界面
```

Thread 也导出了 runtime、store、model catalog、tool、command、skills loader、extension API 和 UI 类型，便于嵌入其他应用。公共接口见 [`src/index.ts`](./src/index.ts)。

延伸阅读：

- [Subagent 架构](./docs/subagent-architecture.md)
- [全局记忆与 Dreamer 架构](./docs/global-memory-architecture.md)
- [给模型用的 grep](./docs/grep.md)

## License

[MIT](./LICENSE)
