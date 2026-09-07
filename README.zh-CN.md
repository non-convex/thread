<div align="center">

# Thread

**一个项目，一棵 Session Tree。你与 agent 的互动，就是项目的记忆。**

[English](./README.md) · [Releases](https://github.com/non-convex/thread/releases) · [开发](#开发)

[![CI](https://github.com/non-convex/thread/actions/workflows/ci.yml/badge.svg)](https://github.com/non-convex/thread/actions/workflows/ci.yml)
[![Bun 1.3.14+](https://img.shields.io/badge/Bun-1.3.14%2B-f9f1e1?logo=bun)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

Thread 是一个围绕项目记忆设计的 coding-agent runtime。需求如何提出，方案为什么被选中，执行得到了什么结果，用户又如何纠正方向——这些互动持续保存在同一棵 Session Tree 中，构成整个项目的记忆，供之后的工作搜索、召回和接续。

Thread 的设计遵循两条理念：**如无必要，勿增实体；精心的上下文管理。**

## 界面

![Thread 欢迎界面](docs/assets/thread-welcome.png)

<p align="center"><em>打开项目，直接进入它的持久化 Session Tree。</em></p>

![Thread 执行编码任务](docs/assets/thread-session.png)

<p align="center"><em>在一个界面中查看思考、工具活动、耗时、上下文用量、模型和 thinking level。</em></p>

## 交互本身就是项目记忆

一个项目只有一棵持久化 Session Tree。每轮用户与 agent 的交互构成一个 turn；连续的 turn 形成路径，回溯后继续工作会产生分支。项目可以拥有多个 Session，它们都属于这棵树，共享项目历史的搜索与召回能力。

```text
Project
├── Workspace
└── Session Tree
    ├── Session A
    │   └── Turn 1
    │       └── Turn 2
    │           ├── Turn 3 → Turn 4
    │           └── Turn 3′ → ...  (after rewind)
    └── Session B
        └── Turn 1 → ...          (created by /new)
```

**记忆在树中的位置，本身就保留了理解它所需的线索。**

- **上下文自然存在。** 一条决定属于哪次交互、基于哪些前置讨论、位于哪条分支，都能沿路径追溯。召回时可以回到原始对话，读取相关的前后轮次。
- **记忆有据可查。** 用户的要求、agent 的回应，以及当轮的工具调用和结果保存在一起，可以据此查看某个结论是在什么条件下、根据什么证据形成的。
- **更新和修改有过程。** 后续的补充、纠正和推翻继续成为新的交互；回溯后的尝试成为新分支，原有路径仍然保留。记忆随着项目推进而演变，旧判断和改变它的过程都有迹可循。

例如，项目早期因某项约束采用了方案 A；后来约束变化，用户与 agent 讨论后改用方案 B。这两次讨论都属于项目记忆。再次问起“为什么采用 B”时，agent 可以搜索相关 turn，回到当时的讨论，理解选择如何变化。

树中的位置提供来源和脉络；判断一条历史结论今天是否仍然适用，还需要阅读相关修订，并在必要时核对当前文件。

## 两条设计理念

### 1. 如无必要，勿增实体

Thread 对功能和特性的增加尽可能保持克制。只有一项能力确实很有用，能帮助用户与 agent 更好地完成项目工作时，才值得加入。让产品保持精简，把精力放在真正有价值的能力上。

### 2. 精心的上下文管理

**只让必须进入模型上下文的内容进入上下文。** 项目记忆持续积累，每次模型请求则围绕当前工作组织上下文。Thread 从活动 Session 的当前路径（live path）构建模型可见内容，按需召回其他历史，并在必要时压缩较早的内容。

- **按需读取。** 搜索先返回相关 turn 的位置与片段，agent 再读取原文和必要的上下文；工具执行细节可以显式展开。
- **工具结果分页。** `read`、`grep` 和 `session_read` 等工具分段返回长内容，agent 按需续读，控制每次进入上下文的信息量。
- **Tool result offloading（待开发）。** 将完整工具结果保存在上下文之外，上下文只保留必要的引用与信息，需要时再读取相关内容。
- **保持稳定。** Skills 在启动时加载为稳定的系统提示前缀，全局记忆使用固定的 Session 快照，尽量维持 prompt cache 命中。
- **谨慎压缩。** Compaction 只在完整 model-step 边界发生，保留近期完整步骤，并且只有预计能显著缩减上下文时才执行。
- **保留原始历史。** 压缩结果用于后续请求，原始交互仍留在树中，可继续搜索、召回和回溯。
- **控制执行细节的占用。** Worker 的完整执行轨迹保存在独立 journal 中，主 agent 接收精简任务结果，并直接检查工作区。

`/compact` 可手动请求压缩。上下文达到 78%，或 provider 报告 overflow 时会自动压缩。每次至少保留最新五个完整 step，并在约 20K token 的目标预算内尽量保留更多近期内容。

目前已实现当前路径构建、按需召回、工具结果分页与压缩；tool result offloading、模型对整棵树的全局感知，以及更细粒度的信息准入机制，仍待开发。

## 快速开始

### 环境要求

- 使用 [standalone release](https://github.com/non-convex/thread/releases)，或从源码运行时准备 Bun 1.3.14+
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

进入 TUI 后运行 `/model all` 选择可用模型，也可以在启动时直接指定：

```bash
thread --root /path/to/project --provider openai-codex --model <model-id>
```

Thread 与 Codex CLI 不共用凭据文件；登录信息保存在 `~/.thread/auth.json`（或 `$THREAD_HOME/auth.json`），应按密码文件保护。使用 `thread logout openai-codex` 可以删除登录信息。

可以在 `~/.thread/config.json` 中覆盖内置模型的本地元数据，而不替换它的 provider 或登录方式。例如，`"modelOverrides": { "openai-codex/gpt-5.6-sol": { "contextWindow": 500000 } }` 会改变 Thread 的上下文预算、显示和压缩阈值，但不能突破 provider 在服务端执行的限制。当 Thread 回退读取 `~/.pi/agent/models.json` 时，也会识别 pi 的 `providers.<provider>.modelOverrides` 嵌套格式。

如果使用 API key 或兼容中转服务，把 [`thread.config.example.json`](./thread.config.example.json) 复制到 `~/.thread/config.json`，修改 provider 与 model，再设置 `apiKeyEnv` 指定的环境变量。自定义 provider 支持 `openai-responses`、`openai-completions` 和 `anthropic-messages`。

## 在同一棵树中工作

### 新建与接续

每个 Session 保存自己的当前路径末端（live tip）。所有 Session 使用同一个项目工作区。

- `/new` 创建并激活一个空 Session，开始一段独立上下文；项目历史继续保留，可按需召回。
- `/session` 列出 Session。
- `/session <id>` 从目标 Session 保存的 live tip 接续工作。

新建和切换 Session 都保持工作区文件不变。`/new` 不复制消息、不调用模型，也不总结历史。

### Turn 连接交互、执行与文件修改

每个 turn 保存用户消息、assistant 输出、工具执行事实与结果、父 turn、结束状态和内置工具的文件编辑记录。`edit` 或 `write` 在一个 turn 内首次修改某个项目文件之前，Thread 保存其原始字节和权限，或记录它原先不存在。Implementation-worker 的编辑归入父 turn。

打开项目、开始和结束 turn 都不会为了 checkpoint 扫描工作区，只有内置编辑工具实际改动的文件才会备份。Bash、脚本和其他工具的改动不被跟踪。失败或中断的 turn 保留已保存的编辑记录，并被补成合法对话前缀继续作为 live tip，让下一条请求从真实发生过的历史继续。

### Rewind 产生分支

`/rewind` 列出 active live path 上的用户 turn。选择一个 turn 后，Thread 会：

1. 校验所需文件备份，将该 turn 及当前路径后续 turn 记录的文件，恢复到这段历史中首次内置编辑之前的状态；
2. 把 Session live tip 移到该 turn 的父节点；
3. 从新路径重建上下文；
4. 在历史中保留所选 turn 及其所有后续内容。

下一条消息会自然生成新的子路径。文件备份缺失或损坏时，操作会在恢复文件及移动 live tip 之前失败。没有文件记录的 turn 仍然可以回退对话。

回退直接覆盖已记录文件，不检测同一路径后续的手工或 bash 修改。内置工具创建的文件会被删除，其他文件不处理，新建的父目录可能保留为空目录。备份对应本 turn 首次内置编辑之前的状态，并非用户发送消息时的整工作区快照。

### 搜索与召回

Agent 通过两个工具使用项目记忆：

| 工具 | 用途 |
| --- | --- |
| `session_search` | 搜索所有 Session 和历史分支中已结束的 turn，返回来源、路径身份和相关片段。 |
| `session_read` | 读取指定 turn 的原文，按需附带附近轮次、工具调用、工具结果或已保存的 thinking。 |

搜索结合支持中文的 BM25、精确标识符匹配与本地语义检索。结果标明内容来自当前路径、当前 Session 的历史分支，还是其他 Session，帮助 agent 判断它与当前工作的关系。

读取附近轮次时，前后关系沿树中的路径计算。当前实现对已离开的历史分支只展开目标的祖先路径；长内容会分页，工具细节默认省略，按需开启。

首次搜索会下载固定版本的 multilingual-e5-small Q8 模型和 tokenizer（约 135 MB）到 `${THREAD_HOME}/models`。模型准备与向量索引在后台运行，关键词搜索可以先用；之后的检索可离线运行。可通过 `HF_ENDPOINT` 设置下载镜像，或配置 `"search": { "semantic": false }` 关闭语义检索和模型下载。索引与检索计算都在本机完成。

工具日志和已保存的 thinking 支持关键词搜索，只有用户与 assistant 的正文参与语义索引。召回工具的调用与结果、压缩摘要和复制内容不重复进入索引；原始证据仍可通过 `session_read` 读取。搜索会报告索引覆盖情况与降级原因。

用户也可以运行 `/thread search "之前为什么这样设计"` 直接搜索。完整说明见[项目记忆搜索原理](./docs/session-recall.md)与[Session 工具参数及示例](./docs/session-tools.md)。

## 跨项目记忆与可选 Agent

跨项目的稳定信息保存在一个 Markdown 文件 `${THREAD_HOME}/.THREAD.md` 中。Main 只在用户当前消息明确给出稳定、跨项目仍有价值的信息时维护它。它作为固定快照进入系统提示，计入上下文预算；文件本身不进入 Session Tree、搜索、rewind 或 compaction。`/new` 为新 Session 读取最新内容，重启时为所有 Session 刷新快照。

`/agent` 是模型选择和 Agent 设置的统一入口。Thread 内置 `main`、`implementation-worker` 与 `dreamer` 三个 Profile。两个次级 Agent 默认关闭，显式选择模型后启用：

| Agent | 启用命令 | 职责 |
| --- | --- | --- |
| `implementation-worker` | `/agent implementation-worker model <provider>/<model>` | 在共享工作区完成一到两个写入范围互不重叠的独立叶子任务，由主 agent 检查文件与测试，并按需要求返工。 |
| `dreamer` | `/agent dreamer model <provider>/<model>` | 在后台审阅互动与执行轨迹，寻找证据充分、可跨项目复用的隐含用户模式和经验，维护全局记忆。 |

Worker 直接编辑当前工作区，`writeScope` 是协调边界。任务属于创建它的父 turn；turn 结束或中断、Thread 关闭或重启，都会取消未完成任务，已写入的文件保留。撤销已记录的内置文件编辑使用 `/rewind`。详见 [Subagent 架构](./docs/subagent-architecture.md)。

Dreamer 在累计十个已结束 turn、Main 连续空闲十分钟后启动。它保持静默，单次运行最多五分钟；大多数审阅都应保持记忆不变。详见[全局记忆与 Dreamer 架构](./docs/global-memory-architecture.md)。

## 命令

| 命令 | 用途 |
| --- | --- |
| `thread login <provider>` | 启动受支持的订阅登录。 |
| `thread logout <provider>` | 删除 provider 凭据。 |
| `thread auth status` | 查看订阅认证状态。 |
| `/new` | 创建空 Session，保持工作区文件不变。 |
| `/session [<session-id>]` | 列出或恢复 Session。 |
| `/rewind [<turn-id-or-user-entry-id>]` | 撤销已记录的内置文件编辑，并回退对话。 |
| `/compact` | 压缩 active live context。 |
| `/model [all\|list [provider]\|<provider>/<model>]` | 查看或选择主模型。 |
| `/agent` | 选择 Agent，再进入它的设置。 |
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

全屏 TUI 中，`Shift+Tab` 循环切换模型支持的 thinking level，`Ctrl+V`（若被终端拦截则用 `Alt+V`）为视觉模型附上剪贴板图片，`Esc` 中断当前 turn。

## 配置与存储

Thread 默认读取 `~/.thread/config.json`；该文件不存在时，会回退到 `~/.pi/agent` 下的兼容设置。主模型选择优先级为：

```text
--provider/--model 或 THREAD_PROVIDER/THREAD_MODEL
→ ~/.thread/state.json 中记住的选择
→ ~/.thread/config.json 中的 model
```

`THREAD_HOME` 修改状态目录，`THREAD_CONFIG` 指定其他配置文件。主模型、thinking level 和次级 Agent 选择会保存在 `~/.thread/state.json`。

Thread 创建或 amend Git commit 时，默认添加 `Co-authored-by: Thread <324980244+thread-agent@users.noreply.github.com>`。用户原有的 Git author 保持不变，GitHub 会把 Thread 识别为共同作者。可通过 `~/.thread/config.json` 中的 `attribution.commit` 替换这段 trailer；设为空字符串即可关闭。

项目状态位于工作区之外：

```text
~/.thread/projects/<project-id>/
├── project.json
├── session-tree/{tree.json,events.jsonl}
├── file-history/blobs/
├── session-search/
└── agent-tasks/events.jsonl
```

Session Tree 与 Agent Task 分别使用独立的 append-only log。文件编辑记录保存在 Session Tree 中，引用按内容寻址的原文件备份；备份记录和内容不进入模型上下文、历史检索结果或可见 transcript。`session-search` 是可从 Session Tree 重建的派生索引。

内置工具显式编辑的项目文件都会被记录，包括 `.gitignore` 忽略的文件和生成目录内的文件；全局记忆与 Thread 自身状态不参与文件历史。`/rewind` 不跟踪 bash、脚本、其他工具、进程或网络副作用。Thread 不实现通用版本控制。

项目和 Session Tree 使用第 2 版数据格式。旧项目数据会被明确拒读，报错给出其位置；Thread 不迁移或自动删除旧数据，需要新的项目状态才能使用新格式。

## 开发

```bash
bun run check
bun test test --timeout 30000
bun run build
```

主要代码边界：

```text
src/session-tree/     持久化项目历史与路径
src/session-recall/   历史检索、派生索引与本地 embedding
src/file-history/     内置文件编辑备份、恢复、校验与 GC
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
- [项目记忆搜索原理](./docs/session-recall.md)
- [Session 工具参数及示例](./docs/session-tools.md)
- [全局记忆与 Dreamer 架构](./docs/global-memory-architecture.md)
- [全屏 TUI](./docs/tui.md)
- [把剪贴板里的图交给模型](./docs/tui-image-paste.md)
- [给模型用的 grep](./docs/grep.md)

## License

[MIT](./LICENSE)
