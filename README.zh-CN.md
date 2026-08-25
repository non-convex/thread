# thread

[English](README.md) | 简体中文

`thread` 是一个 mini coding-agent harness。Project Session 可以伴随项目的整个生命周期，但用户也可以自由决定新的 session 起点。一个 thread version 由 workspace 快照和 conversation context head 共同组成；thread 分支、恢复、比较和合并都会同时作用于这两个维度。

它并不试图复刻 Git 的全部功能。项目没有 staging area、rebase、stash 或逐工具 revision，也没有独立的外部记忆存储。持久项目知识由版本化的 conversation context 及其 compaction state 承载。

## 环境要求

- 从源码运行时需要 Bun 1.3.14 或更高版本
- Git 2.54，或其他支持 `merge-tree --write-tree` 的兼容版本
- 一个 Git worktree

源码构建使用 npm 发布的 `@earendil-works/pi-ai`、OpenTUI 和 SolidJS，不依赖 pi-agent-core、pi-coding-agent、本地 Zig 工具链或本地 OpenTUI 源码树。

```powershell
bun install
bun run build
bun link
```

带 tag 的版本还会在 [GitHub Releases](https://github.com/non-convex/thread/releases) 生成 Windows、Linux、macOS 的 x64/Arm64 独立压缩包。独立可执行程序已经包含 Bun、Solid renderer 和对应平台的 OpenTUI 原生库，使用者无需再安装这些依赖；参与开发时仍建议直接使用体积更小、调试更方便的源码构建。

## 终端界面

交互式 TTY 默认启动全屏 OpenTUI 应用。session screen 在同一个常驻 Solid 渲染树中容纳可滚动 transcript、当前执行轮次、状态、输入框和 footer。位于底部时 transcript 会跟随新输出；滚轮和 Page Up/Page Down 可查看更早的可见条目。一次 turn 的思考、工具调用与回复由一条 accent 竖线串在一起，完成的思考默认保留最多 5 行预览并可点击展开/折叠，工具行会带上参数摘要与耗时。`/model`、`/session` 与不带参数的 `/rewind` 会在输入框上方打开紧凑浮层，对话与输入区保持可见；`/thread merge`、`/thread history` 与较长命令结果会打开应用内整屏 screen，返回后仍是同一个 session，也不会把这些页面写入 conversation。`/clear` 只隐藏当前终端进程渲染的 transcript；`/compact` 强制执行有界的运行时上下文压缩。

进程启动、context restore 及后续 turn 完成时，可见 transcript 都限制为最近 8 次完整的用户主导交互。窗口内的 thinking 与紧凑工具轨迹会保留，并维持到达顺序。该限制只影响应用内 transcript；持久化 session、模型上下文和工具记录都不会删减。

思维链、工具调用和助手回复按到达顺序分层显示：思维链更弱、工具行更紧凑、回复使用 Markdown。用户和助手消息使用 OpenTUI 的宽度感知 Markdown renderer。标题、强调、行内代码、代码块、引用、列表、链接和表格都会获得终端原生布局与语义配色。流式正文会保持同一个 Markdown renderable，只增量更新内容，不再随每批 token 重建组件。

```powershell
thread --tui fullscreen   # 默认：全屏 OpenTUI
thread --tui plain        # readline/文本输出
```

`--tui hybrid` 与 `--tui regular` 仍作为 `fullscreen` 的兼容别名接受。非 TTY 输入或输出会自动选择 plain 模式。在浮层和整屏 screen 中，使用方向键或 Page Up/Page Down 滚动与移动，按 `Esc` 返回。`Ctrl+C` 会中断正在执行的工作；空闲时连续按两次可退出。使用推理模型时，`Shift+Tab` 会循环切换该模型支持的推理档位。OpenTUI 编辑器支持多行输入（`Shift+Enter`）、bracketed paste、项目路径补全和终端感知的光标定位。

## 运行

完成一次 `bun link` 后（或将独立可执行程序放入 `PATH`），在你希望处理的项目目录中启动 harness。当前目录会被解析为包含它的 Git worktree 根目录：

```powershell
Set-Location .\your-git-worktree
thread
```

用户模型配置是全局配置，不会从项目 worktree 读取，也不会写入其中。默认位置是 `~/.thread/config.json`（Windows 为 `%USERPROFILE%\.thread\config.json`）：

```powershell
New-Item -ItemType Directory -Force "$HOME\.thread"
Invoke-WebRequest "https://raw.githubusercontent.com/non-convex/thread/main/thread.config.example.json" `
  -OutFile "$HOME\.thread\config.json"
$env:MY_RELAY_API_KEY = "<secret>"
thread
```

设置 `THREAD_HOME` 可以移动整个用户配置目录。使用 `--config <path>` 或 `THREAD_CONFIG` 可以选择其他配置文件。API key 应通过 `apiKeyEnv` 引用；不要将密钥直接写入 JSON 文件。

如果 thread 配置文件不存在，harness 会回退读取 pi 已有的全局配置：

```text
~/.pi/agent/models.json       provider 和模型定义
~/.pi/agent/settings.json     defaultProvider、defaultModel 和 defaultThinkingLevel
```

当 pi 使用非默认目录时，`PI_CODING_AGENT_DIR` 仍然有效。这是 fallback，而不是配置合并：一旦 `~/.thread/config.json` 存在，或显式传入了 `--config`，就不会再加载 pi 配置。显式指定但不存在的配置文件会报错。pi 中的 `apiKey` 字面值、`$KEY`/`${KEY}` 等环境变量模板以及 `!command` 值会在不把密钥复制到 Project Session 的前提下解析。

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

v1 支持的自定义 API 为 `anthropic-messages`、`openai-completions` 和 `openai-responses`。`contextWindow` 是必填项，因为 harness 会据此决定何时压缩；请填写 relay 模型真实的窗口大小。`defaultThinkingLevel` 可以是 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`，缺省为 `medium`。还可以配置 provider `headers`、模型 `samplingParams`、逐模型 `thinkingLevelMap` 和 pi-ai `compat` 覆盖项；`thinkingLevelMap` 中的 `null` 表示该档位不受支持。

对于 pi-ai 内置 provider，配置只需包含模型选择，并设置该 provider 常规使用的凭据环境变量：

```json
{
  "model": { "provider": "openai", "id": "<model-id>" }
}
```

CLI/环境变量选择仍然可用，并且优先级高于配置文件：

```powershell
$env:THREAD_PROVIDER = "openai"
$env:THREAD_MODEL = "<model-id>"
thread
```

即使没有配置任何模型，版本命令仍然可以使用——唯一的例外是 `/thread diff`，它以 agent turn 的方式运行：

```powershell
thread
```

普通文本会进入流式、多步骤 agent loop。`/new`、`/session ...`、`/model`、`/clear`、`/compact`、`/thread ...` 和 `/rewind ...` 会在 LLM 之前被 harness 拦截，不会成为普通用户消息。

## Project Session

`/new` 会以此刻的 workspace 为起点创建新的 Project Session。Thread 会先在旧 session 中记录 safety checkpoint，再创建带有 genesis workspace 快照、空 conversation context 和 `main` 分支的新 session；不会生成 handoff、调用模型或复制消息。当前模型、thinking level、工具和已加载扩展属于运行进程，因此会继续保留。

使用 `/session` 或 `/session list` 查看保留的 session，使用 `/session switch <session-id-or-unique-prefix>` 切回其中一个。在 TUI 中，裸 `/session` 会打开浮层 picker，可用 ↑/↓、Enter 和 Esc 操作。切换前会先保存当前 workspace，然后同时恢复目标 session 的 workspace 与 context。最近创建或显式激活的 session 会成为下次启动的默认 session。

## 模型切换

无需重启 `thread` 即可查看或更换活动模型：

```text
/model
/model all
/model list
/model list <provider>
/model <provider>/<model>
/model <provider> <model>
```

在全屏 TUI 中，从斜杠命令补全选择 `model` 并按 Enter，会在输入框上方打开浮层列表；默认只包含活动 thread/pi 配置中明确声明的模型。当前模型始终包含在内并用 `●` 标记，即使它来自内置目录或直接切换。使用 ↑/↓ 移动，按 Enter 切换，按 Esc 关闭浮层。`/model all` 打开完整的内置及配置模型目录；长目录会始终围绕选中行显示。

使用推理模型时，在 session 主界面按 `Shift+Tab` 可以循环切换该模型声明支持的档位，当前档位会显示在 footer 的模型名旁边。这个档位会统一用于主 agent loop、自动与手动 compaction、Context Capsule、semantic diff 和 context merge。切换模型后，当前偏好会自动校准到新模型支持的范围。thread 回退使用 pi 配置时会继承 pi 的 `defaultThinkingLevel`；其他情况下缺省为 `medium`。

Plain 模式中的 `/model` 仍用于查看状态。`/model list` 输出配置模型及当前模型，`/model list <provider>` 输出指定 provider 在完整目录中的全部模型。即使某个模型未显示在默认 picker 中，仍可用 `/model <provider>/<model>` 从完整目录直接切换。切换时会保留当前 conversation 和 workspace，同时围绕新模型重建主 agent loop、compactor、Context Capsule、semantic diff 和 context merge 服务。TUI 的模型标签和 context-window 百分比会立即更新。

模型和推理档位都只改变当前运行进程，不会编辑全局配置，也不会追加 message/checkpoint；重启后仍会按照正常优先级使用 `--provider`/`--model`、`THREAD_PROVIDER`/`THREAD_MODEL` 以及配置中的默认值。

## Web 工具

内置 `websearch` 默认通过 Exa MCP endpoint 搜索当前网络信息。设置 `THREAD_WEBSEARCH_PROVIDER=parallel` 可改用 Parallel；另一个可接受值是 `exa`。存在 `EXA_API_KEY` 或 `PARALLEL_API_KEY` 时会附加 provider 凭据；没有密钥时也可能按照 provider 自身的访问策略尝试调用。搜索接收一个 query，以及可选的结果数量（最多 20）、live-crawl 偏好、搜索深度和 context-size 上限。

内置 `webfetch` 可以将一个 HTTP(S) URL 获取为 Markdown、纯文本或 HTML。默认超时为 30 秒（最多 120 秒），拒绝超过 5 MiB 的响应，并将模型可见的转换结果限制为 200,000 字符。二进制响应会被拒绝。两个 Web 工具均被记录为不可重放，因而中断的请求不会被自动再次执行。

`webfetch` 会跟随 HTTP redirect，目前不会阻止 private、loopback 或 link-local 目标。Harness 也没有 Web 专用审批策略，因此当 HTTP 访问能够到达敏感内部服务时，不应让不受信任的模型直接使用它。

## 版本命令

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

`/clear` 不改变任何持久状态：它隐藏当前 context head 之前的消息，之后的消息仍会使用完整后端上下文。重启终端或切换到其他 context 后，这些消息可能再次显示。

`/compact` 强制执行运行时 context compaction，但不会添加用户消息。压缩采用 **fork 当前对话**的方式：复用逐字节相同的前缀（system prompt + messages），只追加一条压缩指令作为最新用户消息，因此请求命中 provider 的 prompt cache，模型读到的是它真实经历过的对话而非投影后的 transcript。回复不会进入 agent loop，只用于替换上下文。由于 fork 携带的正是它将要压缩的那份前缀，压缩改为在 **context window 的 78%** 触发，而不是等到下一次普通请求装不下。压缩后 input context 的目标是模型 context window 的 7%，其中包括 system prompt、tools、extension context、生成的 project state 和保留的原始交互。最终 project state 上限 4K tokens，固定三个小节：`Long-term memory` 以 `- [YYYY-MM-DD] (…)` 分条记录持久知识，最多 25 条，每次压缩重新整理；`Current project state` 描述当前目标、改动、验证、未解决问题与下一步；`Recent user-agent conversation` 以 `- [YYYY-MM-DD HH] (…)` 分条记录，最旧在前，最多 10 条并纯按时间淘汰——有持久价值的内容必须"毕业"进入长期记忆。两个带时间的小节都把时间戳视为**最后修改时间**：由于 provider 的消息格式不携带时间戳，fork 指令中会注明当前本地日期与小时，模型只给本次新写或修改的条目打戳，原样沿用的条目保留旧时间戳。在尾部预算内，compactor 会尽可能保留更多近期完整 user-led interactions，至少两轮。如果两轮本身已超过目标，它们仍会完整保留，因此 7% 是目标而不是破坏性硬限制。压缩会创建一个可恢复的内部 checkpoint，但不会创建 `/thread commit`。如果没有可吸收的更早交互，则操作为空。如果单轮交互过大、一次跳过触发阈值导致 fork 本身装不下，压缩会明确失败并提示使用 `/clear` 或 `/rewind`，不做静默降级。

`HEAD`、thread branch 名称、完整 ID，以及无歧义的 commit/checkpoint ID 前缀都是有效 ref。Thread branch 与主仓库 Git branch 相互独立：切换 thread branch 永远不会移动主 Git 的 HEAD、index、refs 或 reflog。

`/thread diff` 会被拦截并包装成用户消息重新发给 agent，而不是走独立的 diff 服务。agent 用它的常规工具自行读取版本数据——system prompt 中描述了 sidecar 的 session log、object store 与 Context Capsule 的位置和用法——然后以一个普通 turn 作答，因此这次问答本身就是 append-only 的 session 历史。不带参数的 `/thread diff` 比较上一个 thread commit 与当前状态；`<from> <to>` 比较两个显式版本，`--facts` 要求只报告确定性事实、不做解读。有提交的端点附带 Context Capsule，agent 对该版本的记忆已被压缩时可以查阅；当前状态端点永远没有 Capsule，agent 依赖自己的即时记忆。因为它是 agent turn，`/thread diff` 需要已配置模型。

在 TUI 中直接输入 `/rewind` 会打开浮层，按时间列出最近的用户消息；方向键移动高亮，Enter 需要连按两次，因为第二次会丢弃所选消息之后的全部内容。显式给出 ID 则直接回滚。`/thread history` 以整屏形式展示同一批 turn，两者走同一条恢复路径。

Workspace merge 是三方合并，v1 只会应用 clean 结果。在 TUI 中，`/thread merge <ref>` 会打开 preview，让用户选择 context 策略，并在应用前要求确认。`keep-current` 保留当前 context，不调用模型；`summarize` 先展示模型生成的只读 handoff note，确认后才写入 context。Plain/非交互模式可以通过显式 `--context=keep-current|summarize` 直接执行。

## 持久化模型

全局配置与仓库关联的版本状态刻意分离：

```text
~/.thread/
└── config.json                 全局模型/provider 配置

~/.pi/agent/                    config.json 不存在时的只读 fallback
├── models.json
└── settings.json

<git-common-dir>/thread/        此仓库的 workspace + context 版本介质
```

数据位于 worktree 的 Git common directory 下：

```text
<git-common-dir>/thread/
├── store.git/                  独立 sidecar object database
├── projects/<project-id>.json  一个 worktree 的 active session 与激活顺序
├── indexes/<session-id>        私有 Git index
├── sessions/<session-id>/
│   ├── events.jsonl            canonical append-only Project Session log
│   ├── session.json
│   └── cache/                   可重建的 capsules 和 semantic diffs
├── locks/                      project/session 进程锁
└── tmp/
```

启动时，JSONL log 会 replay 为进程内 projection。残缺的最后一行会被丢弃；中间位置的损坏会停止恢复。必须同时出现的状态变化会作为一个 batch record 写入。对于 `replay=never` 工具，`tool_started` 会在副作用之前 flush；启动恢复绝不会盲目再次执行它。

Workspace objects 完全由独立 sidecar 拥有。按时间排列的 retention commits 仅用于让对象保持可达；Checkpoint DAG ancestry 来自 `events.jsonl`。启动 reconciliation 会修复落后于最新持久 checkpoint 的 keep ref。

快照覆盖主仓库已跟踪文件和未被忽略的 untracked 文件。它排除 ignored 文件、空目录、submodule 内部、worktree 外路径、进程、数据库、网络影响和其他外部副作用。Restore 会先创建 safety checkpoint，并拒绝 ignored/out-of-scope collision。Gitlink metadata 会保留在 tree 中，但 submodule 内部内容刻意不恢复。

## 上下文与压缩

原始 session entries 只追加。运行时 compaction 会追加更新后的 project state 和 retained tail，而不是删除旧条目。自动压缩按 context window 比例触发，以便留出发送 fork 压缩请求的空间。Context Capsules 是附着于 checkpoint 的有界、有损缓存；显式 commit 会尝试立即创建，merge 则会延迟生成缺失 Capsule。Capsule 仍使用确定性语义消息投影（排除 provider bookkeeping、hidden thinking 与重复 raw tool details）；compaction 因为直接 fork 真实对话，已不再需要投影。

项目没有独立的 project-memory 服务、检索 projection 或内置 memory tool。长期项目知识必须通过压缩后的 conversation state 延续，因此它会和 session context 的其他部分遵循相同的 branch、checkpoint、restore、diff 和 merge 边界。

## 扩展

受信任的本地扩展可以注册 tools、`/thread` commands 和五个事件：`turn_start`、`before_context`、`before_tool_call`、`tool_result` 与 `turn_end`。

```powershell
bun start -- --root . --extension .\examples\extension.mjs
```

参见 [examples/extension.mjs](examples/extension.mjs)。核心 tool 和 command 名称是保留名称，重复注册会失败。

## 公共 API

`ThreadApp.open()` 可以与注入的 `ModelClient` 一起嵌入其他程序；最小端到端 smoke 也是通过这种方式使用 faux provider。它的 `session`、`versions`、`capsules`、`diff` 和 `merge` 属性始终指向当前 active session runtime。`app.fsck()` 检查 project catalog、所有保留 session 的 log/keep ref 和 sidecar objects。`app.deleteProjectSession()` 只删除当前 active session 的 log、private index 和 keep ref；存在其他 session 时会恢复其中最近激活的一项，然后执行 sidecar GC。它不会删除主 worktree。

## 验证策略

本地验证入口是 `bun run check`、`bun test` 和 `bun run build`。当前刻意保持紧凑的测试覆盖 Project Session 版本循环、多 session 创建/迁移/切换、sidecar 与 replay 安全、异步 turn 准备、模型和推理档位、Web 工具、全屏 session 更新、流式 Markdown 实例稳定性、滚轮加速度、turn 分组、重设计视觉语言的实际渲染、`/model`、`/session` 与 `/rewind` 浮层的 view 侧导航、controller screen 路由与输入提交；不重复测试 OpenTUI 或 `pi-ai` 依赖自身的行为。带 tag 的版本会分别在 Windows、Linux、macOS 的原生 x64/Arm64 runner 上编译。

## 外部项目与归属说明

`thread` 使用或参考了以下外部开源项目：

- [earendil-works/pi](https://github.com/earendil-works/pi)：npm 发布的 [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) 提供模型/provider API。`src/utils/estimate.ts` 的 context-estimation 逻辑派生自 pi，并保留下方的上游 MIT 归属声明。
- [OpenTUI](https://github.com/anomalyco/opentui)、[SolidJS](https://github.com/solidjs/solid) 和 [Bun](https://github.com/oven-sh/bun)：OpenTUI 的 Zig-backed core 与 Solid renderer 提供终端布局和渲染运行时，SolidJS 负责响应式 UI 状态传播，Bun 负责运行、构建和单文件编译。Thread 固定兼容的 OpenTUI/Solid 版本，并把原生库一并放入独立可执行程序。
- [OpenCode](https://github.com/anomalyco/opencode)：其 route-oriented OpenTUI 架构，以及 [`websearch`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/websearch.ts) / [`webfetch`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/tool/webfetch.ts) 工具，为 Thread 的临时 screen 边界和 Web 工具行为提供了参考；Thread 的实现已经适配自身的状态和 tool runtime。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：比较 Web 搜索、抓取和 SSRF 权衡时参考了其 [`tool-web`](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/web/tool-web) package。
- [htmlparser2](https://github.com/fb55/htmlparser2) 和 [Turndown](https://github.com/mixmark-io/turndown)：`webfetch` 用于 HTML 解析和 HTML→Markdown 转换的直接运行时依赖。

上述直接依赖均使用 MIT License。以下声明为派生自 pi 的 context-estimation 代码保留：

```text
MIT License
Copyright (c) 2025 Mario Zechner
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## 许可证

`thread` 使用 [MIT License](LICENSE) 发布。第三方部分仍分别受上述归属声明约束。
