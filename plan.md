# thread mini harness 实施计划

## 0. 产品定位

thread 是一个从零实现的 mini coding-agent harness。它把一次 session 的生命周期提升到整个项目：用户不需要为每个任务新建会话并重新解释目标，而是在同一个 Project Session 中持续开发、创建分支、切换、恢复、比较和合并。

> 项目不是由许多彼此孤立的聊天组成；一个 Project Session 本身就是代码与 session 上下文共同演进的版本空间。

```text
Project Session
├── main
│   └── workspace + context
├── feature/auth
│   └── workspace + context
└── experiment/cache
    └── workspace + context
```

每个 branch head 指向一个 checkpoint；checkpoint 同时包含 workspace snapshot 与 session head。Thread Commit 是 checkpoint 上由用户显式创建的不可变里程碑，不是唯一可以被比较或切换的状态。

项目需要长期保留的知识只存在于 conversation context：较新的原始交互与 compaction 项目状态共同承载它，并随 checkpoint/branch 一起 restore、diff 和 merge。v1 不维护独立于 Session 上下文的外部记忆系统。

### 0.1 v1 的目标

1. 实现一个可用的 agent loop：流式 LLM、工具调用、多 step turn、取消、错误处理和 usage 记录。
2. 一个 Git worktree 默认对应一个可自动恢复的 Project Session；进程重启后继续当前 branch，而不是隐式创建新 session。
3. 使用 append-only session tree 持久化原始消息；每条 branch 有自己的上下文路径和 compaction 历史。
4. 每个 turn 保存 base/result checkpoint，并让当前 branch head 自动前进。
5. 用户可以在同一个 session 内执行 `/thread branch`、`switch`、`restore`、`commit`、`diff` 和 `merge`。
6. branch、commit 和历史消息都可以解析到同一种状态：workspace snapshot + session head。
7. `/thread diff` 同时比较代码和上下文，最终可通过隔离的 LLM 调用生成自然语言结果。
8. `/thread merge` 分开处理 workspace 和 context；context 第一版只提供“保留当前分支”和“总结并引入另一分支信息”两种策略。
9. 提供小而稳定的工具、命令和事件扩展接口。
10. 提供一个真正可用的终端界面：正常对话、流式运行、工具状态、历史恢复，以及不写入主会话的 diff/merge 临时视图。
11. 模型/provider 层使用 `@earendil-works/pi-ai`；终端层使用 Bun + SolidJS + OpenTUI 原生 core。仍不引入数据库、React 或自研 cell renderer；源码使用者不需要 Zig，发布版提供带运行时和原生库的独立可执行程序。

### 0.2 明确的取舍

| 问题 | v1 决策 |
|---|---|
| Project Session 的版本状态包含什么 | workspace snapshot + session head |
| branch 指向什么 | 最新 internal checkpoint，并随每个 turn 自动前进 |
| Thread Commit 是什么 | checkpoint 上的显式、不可变里程碑 |
| 长期项目知识如何持久化 | 由版本化 conversation context 和增量 compaction 项目状态承载 |
| 每次工具调用是否生成版本 | 否 |
| 自动持久化粒度 | 每个 turn 的 base/result checkpoint |
| `/thread` ref 可以指向什么 | branch、commit、`HEAD`；历史 UI 还可使用 internal checkpoint |
| commit 是否有 staging | 否，标记命令执行时的当前 branch 状态 |
| commit 是否必须调用 LLM | commit 先确定性成功，然后尝试生成 Context Capsule；摘要失败不影响 commit |
| diff 是否需要 LLM | 确定性 facts 不需要；默认自然语言结果需要隔离的语义调用 |
| merge 是否合并 context transcript | 不拼接 transcript；保留当前 context，或生成一条有来源的 merge note |
| 是否记录 model/prompt/tool manifest | 不作为版本内容；只为派生缓存记录必要的 model 与 prompt version |
| v1 UI | OpenTUI + SolidJS；TTY 默认使用常驻 alternate-screen 全屏应用，session 与二级 screen 在同一个 Solid root 内切换，非 TTY 自动 plain fallback |
| TUI 长历史 | session scrollbox 只投影当前 branch 最近 8 次用户主导交互；完整 session/context/tool records 仍在持久化层 |
| TUI 依赖边界 | core 不 import OpenTUI/Solid；结构化运行事件和命令结果先进入 renderer-neutral controller/UI projection，再由 terminal/plain adapter 渲染 |
| v1 持久化 | pi 风格 append-only JSONL 事件日志；启动时重放为内存投影 |
| SQLite | v1 不实现；Project Session 规模证明文件日志成为瓶颈后再作为 v2 索引/存储方案评估 |
| 测试策略 | 只测试数据安全、崩溃后禁止重复副作用和最小版本闭环；不建设全面单元/性质/性能测试矩阵 |

### 0.3 术语

- **Project Session**：以项目为生命周期的长期 session，包含 session tree、branch refs、checkpoints 和 commits；长期项目知识位于版本化 context 内。
- **entry**：session tree 中的一条不可变记录，如消息、压缩摘要或 context merge note。
- **session head**：某条 branch 当前上下文路径的叶节点。
- **turn**：一次普通用户消息进入 agent，直到 agent completed、aborted 或 failed。
- **turn base checkpoint**：普通用户消息进入 agent loop 之前的代码和 session head。
- **turn result checkpoint**：该 turn 结束后的代码和 session head。
- **internal checkpoint**：自动产生的代码 + 上下文状态，也是所有 branch/commit 的实际目标。
- **BranchRef**：分支名称到最新 checkpoint 的可移动指针。
- **Thread Commit**：用户显式附着到 checkpoint 的不可变里程碑和说明。
- **VersionRef**：branch、commit、`HEAD` 或内部 history checkpoint 的统一解析结果。
- **Context Capsule**：从某个 checkpoint 的有效运行上下文生成的固定长度语义摘要；它是派生缓存，不是版本身份的一部分。
- **semantic call**：由命令处理器发起的临时 LLM 调用；默认不进入主会话。

---

## 1. Checkpoint DAG、BranchRef 与 Thread Commit

### 1.1 Checkpoint DAG 是状态历史的事实源

每个 turn 是两个 checkpoint 之间的一条转换：

```text
base checkpoint
  ── user message + agent steps + tools ──>
result checkpoint
```

普通 checkpoint 有一个 parent；merge result 有两个 parents。因此内部历史从一开始就是一个小型 DAG：

```ts
type CheckpointReason =
  | "genesis"
  | "turn_base"
  | "turn_result"
  | "safety"
  | "command"
  | "recovery"
  | "merge";

interface InternalCheckpoint {
  id: string;
  sessionId: string;
  parentCheckpointIds: string[];
  sessionHeadId: string | null;
  workspaceTreeOid: string;
  retentionCommitOid: string;
  reason: CheckpointReason;
  outcome?: "completed" | "aborted" | "failed";
  details?: {
    sourceRef?: string;
    restoreMode?: "workspace" | "context" | "both";
  };
  createdAt: number;
}

interface Turn {
  id: string;
  sessionId: string;
  branchName: string;
  userEntryId: string;
  baseCheckpointId: string;
  resultCheckpointId: string | null;
  outcome: "running" | "completed" | "aborted" | "failed";
  startedAt: number;
  finishedAt?: number;
}
```

Checkpoint DAG 负责：

- branch ancestry 和 common ancestor；
- 历史消息恢复；
- crash 后解释部分完成的 turn；
- diff/merge 的真实 base；
- 显式 commit 的实际内容；
- restore/switch/merge 前的 safety snapshot。

sidecar retention chain 和筛选后的 Thread Commit 列表都不能替代 Checkpoint DAG。

### 1.2 BranchRef 是长期 session 的活动指针

```ts
interface BranchRef {
  sessionId: string;
  name: string;
  headCheckpointId: string;
  createdAt: number;
  updatedAt: number;
}
```

规则：

1. Project Session 初始化时创建 `main`，指向 genesis checkpoint。
2. 普通 turn 开始前，base checkpoint 成为当前 branch head；turn settle 后 result checkpoint 再成为 head。
3. `/thread branch <name> [<from>]` 从当前 `HEAD` 或指定 VersionRef 创建 branch；默认创建并切换。
4. `/thread switch <branch>` 在 idle 状态下保存当前 branch 的最新 workspace/context，再恢复目标 branch checkpoint。
5. branch 之间共享 session tree 的公共祖先，但各自沿不同 parent path 构造上下文和 compaction。
6. 每次 branch 移动都写 append-only reflog；restore 后仍可找回旧 head。
7. 同一进程一次只激活一个 branch；v1 不并行运行多个 lane。
8. 启动恢复时先比较实际 workspace 与当前 branch head；idle 状态下发现人工改动就捕获为 recovery checkpoint，而不是静默覆盖。

Thread branch 与主仓库 Git branch 是两个独立概念。`/thread switch` 只切换 workspace snapshot + session context，不移动主仓库 `HEAD`、index、refs 或 reflog；UI 必须始终使用 “thread branch” 避免混淆。

### 1.3 恢复历史消息的精确定义

用户选择一条历史用户消息时，恢复到该消息进入 agent loop **之前**：

```text
main: t1 ── t2 ── t3 ── t4
                 ↑
              选择 t3

恢复后：

main: t1 ── t2 ── t3' ── t4'
              \
               旧 t3 ── 旧 t4   # 仍在 session tree/reflog 中
```

实现规则：

1. 通过 `Turn.userEntryId` 找到 `baseCheckpointId`。
2. 默认同时恢复该 checkpoint 的 workspace 与 session head，并移动当前 BranchRef。
3. 恢复前捕获当前状态为 safety checkpoint，避免 turn 之后的手工修改丢失。
4. session tree 不删除旧分支；BranchRef 移动前后的 head 写入 reflog。
5. navigation 操作写 durable record，但不伪造成普通 user/assistant message。
6. 核心 API 保留 `workspace | context | both` 三种恢复模式；UI 默认 `both`。
7. 部分恢复创建一个单 parent checkpoint，并在 `details` 中记录来源；完整恢复可以直接移动 BranchRef 到目标 checkpoint。

### 1.4 Thread Commit 是显式里程碑

```ts
interface ThreadCommit {
  id: string;
  sessionId: string;
  checkpointId: string;
  message: string;
  createdAt: number;
}
```

```text
main checkpoints:  t1 ── t2 ── t3 ── t4 ── t5
                          ▲          ▲
Thread Commits:           c1         c2
                                      ↑
                               main branch head 可继续前进
```

规则：

1. `/thread commit` 捕获当前 branch 的 workspace/session head；匹配现有 head 时直接标记，否则先创建 `reason=command` checkpoint 并移动 branch。
2. commit 没有 staging area，也不依赖主仓库 index。
3. commit 不建立另一套 ancestry；两个 commits 的祖先关系通过它们所指 checkpoint 在 Checkpoint DAG 中计算。
4. `/thread log` 默认把拥有 commit annotation 的 checkpoint 作为里程碑展示，可选择 `--all` 展示 turn checkpoints。
5. merge checkpoint 可以有两个 parents；附着其上的 commit 自然表现为 merge milestone。

### 1.5 VersionRef

```ts
type VersionRef =
  | { kind: "branch"; name: string; checkpointId: string }
  | { kind: "commit"; id: string; checkpointId: string }
  | { kind: "checkpoint"; id: string }; // 仅 history/reflog/internal API
```

用户命令可使用 branch、commit、无歧义短 ID 和 `HEAD`：

```text
/thread diff main feature/auth
/thread diff c1 c2
/thread restore c1
/thread merge experiment/cache
```

`HEAD` 始终表示当前 BranchRef 的最新 checkpoint。完整 restore/switch 会移动 BranchRef；只恢复 workspace 或 context 则在当前 branch 上创建新的组合 checkpoint。

---

## 2. 输入路由与 LLM 边界

### 2.1 输入路由

所有用户输入先经过路由器：

```text
User Input
├── /thread ...  → ThreadCommandRegistry
├── /rewind ... → Session navigation handler（CLI 的历史恢复入口）
└── other       → Main Agent Loop
```

`/thread` 命令永远不先作为普通消息写入 session，也不自动发给主 agent 模型。

### 2.2 三类模型调用

为了避免“是否进入主上下文”的歧义，harness 明确区分三条路径：

```text
MainAgentRunner
  普通对话和工具循环；结果写入 session tree

CompactionRunner
  压缩运行上下文；结果作为 compaction entry 写入 session tree

SemanticRunner
  为 commit capsule、diff、merge note 等服务；默认不写入主 session
```

只有 context merge 的 `summarize` 策略是例外：SemanticRunner 的自由文本结果会被包装为带来源的 `context_merge` entry，成为后续主上下文的一部分。

### 2.3 命令处理接口

```ts
interface ThreadCommand {
  name: string;
  description: string;
  execute(args: string[], ctx: ThreadCommandContext): Promise<CommandResult>;
}

interface ThreadCommandContext {
  session: SessionService;
  workspace: WorkspaceService;
  versions: VersionService;
  semantic: SemanticRunner;
  signal: AbortSignal;
}

interface CommandResult {
  presentation:
    | { kind: "inline"; content: string }
    | { kind: "view"; view: EphemeralView };
  changedState: boolean;
}

type EphemeralView =
  | { type: "document"; title: string; content: string }
  | { type: "thread_diff"; from: string; to: string; facts: ThreadDiffFacts; semantic?: string }
  | { type: "thread_merge"; preview: ThreadMergePreview };
```

命令可以选择完全不使用 `SemanticRunner`，也可以显式调用它。`CommandResult` 是 UI-neutral 的：普通结果可以内联，diff/merge 等结果打开临时 view；plain adapter 仍能把同一结果格式化为文本。任何 view 的打开、滚动、关闭和选择状态都不写入 session tree。

### 2.4 第一批命令

```text
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
```

初始语义：

| 命令 | 状态来源 | 是否调用 LLM |
|---|---|---|
| `status` / `branches` | Project Session、当前 branch、各 branch head | 否 |
| `branch` / `switch` / `reflog` | BranchRefs、checkpoints、ref log | 否 |
| `log` / `show` / `history` | Checkpoint DAG + commit annotations + branch turns | 否 |
| `commit` | 当前 branch head | commit 本身否；随后尝试生成 capsule |
| `diff --facts` | 两个 VersionRefs | 否 |
| `diff` | facts + capsules | 是，失败时降级为 facts |
| `restore` | 目标 VersionRef | 否 |
| `merge --context=keep-current` | 当前 branch + 目标 VersionRef | context 不调用；workspace merge 不调用 |
| `merge --context=summarize` | 公共祖先 + 当前 + 目标 | 是 |

命令的具体参数和输出文案可以在对应 phase 再调整；数据模型不能依赖某一种 CLI 拼写。

### 2.5 TUI 调研结论（2026-08-19，2026-08-24 修订决策）

本节只记录会影响 thread 选型的事实，不照搬三个产品的整体前端架构。

| 项目 | 当前实现 | 值得采用的语义 | 不适合直接采用的部分 |
|---|---|---|---|
| pi `0.84.2` | `@earendil-works/pi-tui`；同一 `Component` 树可由 main/alternate renderer 渲染 | Editor、补全、终端输入和退出恢复语义成熟 | 长历史仍需在 JS 侧渲染完整组件文档；布局、美化和复杂页面的长期上限较低 |
| Claude Code `2.1.88` | 自研 React/Ink 栈：React reconciler + TS Yoga + front/back cell buffer + 16ms 合批 + alternate screen + virtual scroll | UI 是 agent 事件的投影；流式组件与完成组件分离；长 transcript 必须窗口化；modal/diff 不应污染主消息 | 自建 Fiber host、Yoga、cell renderer、selection/search/virtualization；这已经是独立 UI 平台，不符合 mini harness |
| OpenCode / OpenTUI | OpenTUI `0.5.7`：Zig native core + TS binding + SolidJS，split-footer / alternate-screen、增量 Markdown、Yoga 布局和 route/dialog 体系 | native diff rendering、高性能布局；终端能力与业务状态分层；语义 theme token 易于继续美化 | Bun、Solid、native ABI、平台预编译和 parser assets 扩大发布体积，需要建立真正的平台产物链路 |
| 当前 Thread | OpenTUI alternate-screen 全屏应用；session transcript、live turn、composer 与二级 screen 共用一个 Solid root | 状态投影和 renderer 分层；transcript 有界、viewport culling、输入区固定，screen 切换不污染 conversation | 单文件发布约百 MiB；原生 ABI 要固定版本并按平台构建 |

源码锚点：

- pi：[TUI 源码](https://github.com/earendil-works/pi/tree/main/packages/tui/src)以及 coding-agent 的 interactive mode。
- Claude Code 逆向参考仓库：`src/ink/`、`src/screens/REPL.tsx`、`src/ink/components/ScrollBox.tsx`。
- OpenCode：[TUI app](https://github.com/anomalyco/opencode/blob/dev/packages/tui/src/app.tsx)、[TUI package](https://github.com/anomalyco/opencode/blob/dev/packages/tui/package.json)、[OpenTUI](https://github.com/anomalyco/opentui)、[renderer modes](https://opentui.com/docs/core-concepts/renderer/)。

最初在把工作量作为主要约束时倾向 pi-tui；当决策明确为“不考虑迁移工作量，优先流畅性能和未来美观化”后，结论改为 OpenTUI + SolidJS。关键理由不是追求 IDE 规模，而是 OpenTUI 已直接提供 native layout/rendering、alternate-screen、增量 Markdown、scrollbox 和可组合 theme primitives，Thread 不必自己维护 renderer。

### 2.6 技术选型与依赖边界

固定兼容的 Bun、OpenTUI 和 SolidJS 版本；模型层继续使用公开发行的 pi-ai：

```json
{
  "dependencies": {
    "@earendil-works/pi-ai": "^0.84.2",
    "@opentui/core": "0.5.7",
    "@opentui/solid": "0.5.7",
    "solid-js": "1.9.12"
  }
}
```

运行与构建统一使用 Bun 1.3.14；`bunfig.toml` preload 和 `@opentui/solid/bun-plugin` 负责编译 Solid JSX。仍然不依赖 `pi-agent-core` 或 `pi-coding-agent`，也不 vendor/fork OpenTUI。源码安装由 OpenTUI optional package 自动选择当前平台的预编译 native core，不要求用户安装 Zig。

OpenTUI/Solid 依赖只允许出现在 `src/ui/terminal/` 和构建脚本。agent loop、session、versions、commands、tools 和 extensions 不能 import renderer 类型；`ThreadTuiController` 维护 renderer-neutral 的 `UiState`，Solid view 只订阅 revision 并投影该状态。这样未来替换 renderer 不影响持久化格式、命令语义和版本模型。

发布不能让最终用户手工拼装 Bun/Solid/native library。普通源码构建保留 npm dependencies；tag release 使用 Bun compile 在 Windows、Linux、macOS 的 x64/Arm64 原生 runner 上生成独立程序并打包上传。每个平台都从自己的 optional OpenTUI package 嵌入 native core 和 parser assets；`--help` 与 TTY lifecycle 都从最终产物验证。

运行模式：

```text
TTY session              → alternate-screen / transcript scrollbox + 固定底部输入区
model/diff/merge/history → 同一 Solid root 内的全屏二级 screen
非 TTY 或 --tui plain   → PlainPresenter / 无 ANSI、无 raw mode
```

renderer 在交互进程生命周期内保持 `alternate-screen + passthrough`；session、model、diff、merge、history 和 document 只切换 `UiState.screen`，不切换终端 screen mode。`--tui fullscreen` 是首选名称，`hybrid`/`regular` 仅保留为 CLI 兼容别名。plain 不维护另一套业务状态，只消费相同事件和 `CommandResult`。

### 2.7 UI 事件管线

当前 `onTextDelta(delta)` 不足以表达工具、压缩、步骤、取消、命令执行和版本 head 变化。增加一条只用于展示的结构化事件流；它与 durable records、extension events 完全分离：

```ts
type UiEvent =
  | { type: "command_started"; name: string }
  | { type: "command_finished"; name: string; ok: boolean }
  | { type: "head_changed"; branch: string; checkpointId: string; reason: "turn" | "command" | "switch" | "restore" | "merge" | "recovery" }
  | { type: "turn_started"; turnId: string; input: string; branch: string }
  | { type: "assistant_started"; step: number }
  | { type: "assistant_text_delta"; step: number; delta: string }
  | { type: "assistant_thinking_delta"; step: number; delta: string }
  | { type: "tool_started"; id: string; name: string; args: unknown }
  | { type: "tool_finished"; id: string; name: string; result: ToolResult; isError: boolean }
  | { type: "compaction_started"; reason: "threshold" | "overflow" | "manual" }
  | { type: "compaction_finished"; ok: boolean }
  | { type: "turn_finished"; outcome: "completed" | "aborted" | "failed"; checkpointId?: string };

interface RunTurnOptions {
  signal: AbortSignal;
  onUiEvent?: (event: UiEvent) => void;
}
```

规则：

1. `onUiEvent` 是同步、非阻塞 observer；输入路由器以同一个安全 sink 包装 command/head 事件；UI 异常不能改变 agent 执行或 durable write 顺序。
2. durable records/session entries 仍是事实源；UI event 不持久化，重启后从 session projection 重建稳定 transcript。
3. `TerminalApp` 用纯 reducer 把事件变成 `UiState`；components 不直接订阅 `SessionService` 的内部 Map。
4. text delta 先进入 accumulator，每 16–33ms 最多 flush 一次，只更新当前 assistant component；不能每个 token 重建整个 transcript。
5. 已完成的 message/tool component 视为 immutable；只让当前 streaming message、当前 tool、status 和 footer 失效重绘。
6. shell 工具输出必须被 capture；任何业务代码、工具或 extension 都不能直接写 stdout。调试日志写 sidecar log，退出 TUI 后才打印致命错误。

UI event 不是新的插件事件面。扩展仍使用 9.3 的五个稳定事件；否则展示细节会反向锁死核心扩展协议。`head_changed` 只用于刷新投影，事实仍以已经落盘的 BranchRef/checkpoint event 为准。

### 2.8 Screen model 与交互

```ts
type ScreenState =
  | { type: "session" }
  | { type: "history"; branch: string; cursor?: string }
  | { type: "diff"; result: ThreadDiffResult }
  | { type: "merge"; preview: ThreadMergePreview; selectedContext: "keep-current" | "summarize" };
```

主 session 与二级页面由同一个全屏渲染树管理：

```text
OpenTUI alternate-screen root
└── Switch(UiState.screen)
    ├── SessionScreen
    │   ├── transcript + LiveTurn scrollbox   # 最近 8 次交互 + thinking → tool → reply
    │   ├── slash/path suggestions            # 有内容时覆盖在输入区上方
    │   ├── Pending/Running status
    │   ├── Textarea                          # 多行输入、slash/path autocomplete
    │   └── Footer                            # thread branch、version、context、model/thinking
    └── model/diff/merge/history/document screen
```

交互规则：

1. `/clear`、`/compact`、`/model`、`/thread ...` 与 `/rewind ...` 均由 harness 在 LLM 前拦截；command input 不进入 transcript。
2. 普通 command 可以显示一条短 inline notice；`diff`、`merge`、`history` 打开独立 screen，`Esc` 返回原 session，结果不追加成消息。
3. `/thread diff` view 先显示 semantic summary，再显示可独立核验的 context facts 和 workspace facts；semantic 缺失时 view 仍完整可用。
4. `/thread merge <ref>` 先计算 preview，用户在 view 中选择 `keep-current` 或 `summarize`，确认后才 apply。workspace conflict 只显示确定性报告并阻止 apply；v1 不在 TUI 中实现 conflict editor/continue/abort。
   plain/automation 场景可显式传入 `--context=keep-current|summarize` 直接执行，省略该参数才返回交互 preview。
5. merge note 预览必须标记 `generated` 和来源 ref；v1 只读展示，不增加文本编辑器。只有确认 merge 后才 append `context_merge` entry。
6. history view 用 turn/user-message 列表选择恢复点，默认恢复到该用户消息之前；确认页明确显示将恢复的 workspace checkpoint 与 context head。
7. 键盘是一等输入：`Esc` 关闭 view/中断活动操作，`Ctrl+C` 清空当前输入或二次退出，方向键/Page Up/Page Down 滚动，`Enter` 选择；模型/历史列表额外接受 `j/k`。session scrollbox 使用 sticky-bottom 跟随流式输出，用户手动上滚后停止抢回位置。任何动作都不能只靠鼠标完成。
8. footer 不显示虚假的百分比进度；运行态只显示 elapsed time、当前 step/tool 和可中断提示。
9. Project Session 不提供主动清空 context 的命令。用户需要隔离实验时创建 branch；长期上下文体积统一由自动或手动 compaction 管理。
10. `/clear` 只在 terminal adapter 中记录当前 context entry 作为显示隐藏锚点；不写 session log、不移动 lane、不改变后续 LLM 上下文。
11. user/assistant 正文使用 OpenTUI `MarkdownRenderable` 和 Thread 自有的语义主题；流式 leaf 开启 incremental streaming，并以稳定 block 位置保留同一个 renderable，只更新 `content`，不能按 token batch 销毁重建。正文设置可读宽度上限，表格、中文宽字符和未闭合 fence 交给 OpenTUI native core。
12. `/compact` 强制执行一次 runtime compaction，但不作为用户消息进入 transcript；成功后创建内部 command checkpoint 保持 branch head 与 lane 一致，它不是 `/thread commit`。

### 2.9 长 Project Session 的渲染策略

session screen 使用常驻 OpenTUI scrollbox，但只投影有界的 transcript，因此实时组件数不随 Project Session 总长度增长。

1. 新进程、restore/switch 和每个完成 turn 都从当前 branch path 投影最近 8 个 user-led interactions；更早条目不挂载到渲染树。
2. 活动 turn 作为 `LiveTurn.blocks` 追加在稳定 transcript 后面，并按到达顺序显示 thinking、tool 与 reply；完成后由 durable session entry 替换 live state。
3. tool 历史默认只显示一行 call/result summary；thinking 用弱化文本保留；原始 durable entry 不受 UI 摘要影响。
4. `/clear` 记录当前进程内的隐藏锚点；restore、switch 和 merge 重新计算 transcript projection。
5. diff/merge/history/document 使用同一 alternate-screen root 和 viewport culling；离开时销毁对应 screen subtree并返回 session。
6. compaction 前后的原始消息仍可从 session log 查询；可见 transcript 不参与上下文装配，也不改变 restore/diff 的事实源。

终端兼容底线：

- renderer 负责 raw mode、Bracketed Paste、Kitty 键盘协议、宽字符、hardware cursor、resize 和 synchronized output；业务层不手写 cell width 或 ANSI diff。
- 所有 start 都必须有 `try/finally destroy()`；同时处理正常退出、SIGINT/SIGTERM/SIGHUP 和 renderer destroy，确保恢复 cursor、raw mode 和 terminal protocol。
- 颜色通过少量 dark/light semantic token 集中定义，为未来美化保留稳定入口；v1 不建主题市场、图片协议或任意插件 theme API。
- 小于 60 columns 时隐藏次要 footer 字段并使用纵向 facts；diff/merge 永不要求并排 pane。

---

## 3. Session tree、压缩与 Context Capsule

### 3.1 Session 持久化采用 pi 的核心语义

实现参考 pi，但不依赖 `pi-agent-core` 或 `pi-coding-agent`：

- entry 是 append-only 的；
- entry、durable record 和版本事件统一追加到 Project Session 的 JSONL 日志；
- 每个 entry 有 `id`、`seq`、`parentId` 和 `timestamp`；
- 每个 BranchRef 对应一个命名 lane，lane pointer 指向该 branch 正在追加的 leaf；
- 移动 leaf 后继续 append 会形成分支；
- compaction 追加摘要，不覆写或删除旧消息；
- `buildSessionContext(head)` 沿目标 branch 构造真正送给模型的有效上下文。

v1 entry 面保持很小：

```ts
interface EntryBase {
  id: string;
  sessionId: string;
  seq: number;
  parentId: string | null;
  timestamp: number;
}

type SessionEntry =
  | (EntryBase & { type: "message"; message: AgentMessage })
  | (EntryBase & {
      type: "compaction";
      summary: string;
      retainedTail: AgentMessage[];
      tokensBefore: number;
    })
  | (EntryBase & {
      type: "context_merge";
      sourceRef: string;
      sourceCheckpointId: string;
      commonAncestorCheckpointId: string | null;
      content: string;
    })
  | (EntryBase & {
      type: "custom";
      customType: string;
      data?: unknown;
    });
```

`context_merge` 的 `content` 是自由文本，但 entry 类型和来源是确定的。Context assembler 将它投影为带清晰前缀的上下文消息，不能伪装成用户原话。

### 3.2 上下文压缩

`buildSessionContext(head)` 使用目标 branch 上最近的 compaction entry：

```text
latest compaction summary
+ retained tail
+ compaction 之后的新 entries
```

原始旧 entries 仍然留在存储中，用于历史 UI、审计和分支恢复；它们不会因为 runtime 压缩而消失。

压缩算法保持小而明确：

- 每次主模型调用前，先完成 system prompt、tool definitions 和 `before_context` 扩展装配，再对完整 request 估算 token；
- 主调用显式使用一个输出预算（默认取模型上限、16K、context window 的 20% 三者最小值），触发条件为 `request + output budget + 4096 safety > context window`；
- 压缩后的总 input context 目标为模型窗口的 7%，该预算包含 system prompt、tools、extension context、compaction summary 和近期原文；
- 尾部按 user message 开始的完整交互边界切分；在 `7% target - 固定上下文 - 4K summary reserve` 的剩余预算内，从后向前尽可能多保留完整 user-led interactions，最少保留两个，并至少留下一个更早交互进入摘要。短回复会保留更多轮，大 tool result 会使尾部收缩到两轮；如果最近两轮本身超过目标则允许超过 7%，不破坏交互边界；摘要不会重复保留尾部；
- compaction prompt 明确写入对应输出上限，并要求只保留工具调用的关键结论和必要诊断，不生成 command 清单；只有复现关键验证或未解决失败所必需时才保留精确命令，重复测试/尝试合并为结论，常规导航、检查及无后续价值的成功命令直接省略；不复制长文件内容、搜索结果或日志；
- 进入摘要模型前，消息先经过与 Context Capsule 共用的确定性语义投影：排除 provider 元数据、usage、thinking、签名、图片二进制和 `details.raw`，保留每条消息的 `YYYY-MM-DD` 来源日期、用户可见文本、tool call、模型可见 tool result 以及材料性停止/错误状态；
- compaction 输出同时包含选择性的长期项目记忆、材料性的当前项目状态和滚动的近期已压缩会话摘要。长期记忆只保留可能帮助未来工作的稳定信息；近期摘要包括用户最近讨论、要求或纠正的内容，但不重建逐轮 transcript；
- 第一次 compaction 从旧前缀创建完整项目状态；再次 compaction 时把最近的 compaction summary 明确作为 `PREVIOUS PROJECT STATE`，只把新进入旧前缀的交互作为 `NEW INTERACTIONS TO ABSORB`。更新时重新判断旧记忆的有效性和未来价值，使用较新纠正覆盖旧状态，舍弃过时、临时或无后续价值的条目，并替换旧的近期会话摘要；时间敏感或发生覆盖的条目按需保留绝对日期；
- 前缀若超过一次 compaction request 的窗口，按时间顺序生成不超过 1536 tokens 的分块摘要，再递归归并，最终生成不超过 4K tokens 的 continuation summary；
- 支持 threshold compaction、overflow 后 compaction，以及用户显式 `/compact`；
- `/compact` 使用 durable compaction operation，成功后产生内部 command checkpoint，但不产生 ThreadCommit；
- 摘要失败不修改当前 leaf；原始 entry 始终保留。

不同 branch 的 compaction entry 位于各自 session path 上。切换 branch 后直接复用该 path 最近的 compaction 状态，不需要用户重新叙述目标。v1 不要求扩展替换 compaction 算法，只保留未来可替换的 `ContextCompactor` 接口。

### 3.3 Context Capsule 绑定 checkpoint

长 Project Session 的原始增量可能远超单次模型窗口，因此 `/thread diff` 不能临时把两个 refs 之间的全部 transcript 塞给模型。

Capsule 的缓存主体是 checkpoint，而不是 commit：显式 commit 创建成功后立即尝试生成；普通 turn 不生成；当 branch head 参加 semantic diff/merge 且尚无 capsule 时按需生成。

```text
VersionRef → checkpoint
  ↓
buildSessionContext(checkpoint.sessionHead)
  ↓
应用独立的 capsule token budget
  ↓
SemanticRunner
  ↓
保存 Context Capsule
```

Context Capsule 描述当时 agent 的整体工作状态，例如目标、关键事实、已做决策、验证结果和未解决问题。输出是 prompt 驱动的自由文本，不规定业务 JSON schema。

```ts
interface ContextCapsule {
  checkpointId: string;
  sourceSessionHeadId: string | null;
  trigger: "commit" | "diff" | "merge" | "manual";
  status: "ready" | "failed";
  content?: string;
  model?: string;
  promptVersion: string;
  error?: string;
  createdAt: number;
}
```

不变量：

1. capsule 不参与 checkpoint/commit 身份，也不改变 workspace、session head 或 BranchRef。
2. commit 先落盘；eager capsule 调用失败时 commit 仍然有效。
3. v1 不引入后台任务队列；commit 后同步尝试一次，branch diff/merge 使用时允许按需生成或重试。
4. capsule 默认不注入主 agent 上下文。
5. raw entries 才是上下文事实源；capsule 明确是有损语义投影。
6. capsule 只读取 checkpoint 当时 compaction-aware 的有效上下文，不重新拼接无限长的原始增量。

### 3.4 Context diff 的事实层

确定性 ContextDiff 不把全部消息复制到一个对象，只提供结构与可分页引用：

```ts
interface ContextDiffFacts {
  commonAncestorEntryId: string | null;
  fromOnly: { count: number; firstEntryId?: string; lastEntryId?: string };
  toOnly: { count: number; firstEntryId?: string; lastEntryId?: string };
  countsByType: Record<string, number>;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  compactionCount: number;
}
```

完整消息通过分页 API 按需读取，不作为默认 semantic diff prompt 的输入。

---

## 4. Workspace snapshot backend

### 4.1 范围

v1 要求工作目录属于一个 Git worktree。Workspace Snapshot 包含：

- 主仓库 tracked 文件；
- 非 ignored 的 untracked 文件；
- 文件删除与 executable bit；
- Git 能表示的 symlink/gitlink 信息。

明确排除：

- ignored 文件；
- 空目录；
- 工作区外路径；
- 子模块内部工作区状态；
- 网络、数据库、`git push`、后台服务等外部副作用。

restore 只承诺恢复上述 scope。Detached/background shell process 在 v1 禁止或明确标记为不受管理，因为它可能在 turn checkpoint 后继续写文件。

### 4.2 独立 sidecar Git 仓库

优先方案是完全独立的 sidecar bare repository，不在主仓库创建 refs，也不长期依赖主仓库 object database：

```text
<git-common-dir>/thread/
├── store.git/
├── indexes/<session-id>
├── sessions/<session-id>/
│   ├── events.jsonl
│   ├── session.json
│   └── cache/
├── locks/
└── tmp/
```

捕获路径集合由主仓库 Git 计算，以保留 tracked/ignore 语义；内容写入 sidecar 自己的 ODB。推荐尖刺的方向：

```text
main repo:
  git ls-files --cached
  git ls-files --others --exclude-standard

sidecar repo + private index:
  批量移除已不在 snapshot scope 的旧路径
  批量 force-add 当前候选路径
  git write-tree
  git commit-tree     # 仅创建 retention commit
```

sidecar retention commit 按捕获时间串成单链，并由一个 sidecar 内部 ref 保活：

```text
refs/keep/<session-id>
```

该 parent 链只服务对象可达性与 GC，**不表示 Project Session 的状态 ancestry**。Checkpoint DAG 永远来自 session 事件日志重放出的投影。

### 4.3 已验证、可以采信的本机 Git 事实

以下事实已在 git 2.54.0.windows.1 / Windows 10.0.22631 实测，不需要重复证明：

| 事实 | 结果 |
|---|---|
| `GIT_INDEX_FILE` 隔离 | 不修改主仓库 index/status |
| `git add -A` 使用私有 index 并尊重 ignore | 已通过；小修改约 44ms，300 文件约 1.5s |
| `merge-tree --write-tree` | 冲突时仍给出结果信息和 stage OID，退出码为 1 |
| `update-ref --stdin` | 同一个 Git 仓库内支持 CAS 事务 |
| `refs/*` 对对象 GC 保活 | 已通过 `gc --prune=now` |
| `checkout-index --prefix` | 可以物化任意 index 到临时目录，不碰主工作区 |
| Git 进程启动 | 约 28ms |
| batch plumbing | 300 文件从逐进程 9.9s 降到约 0.143s |

仍然保留两个设计结论：

1. 主仓库 `refs/*` 会污染 `git log --all`，本地 `GIT_NAMESPACE` 不能解决，因此首选独立 sidecar。
2. agent 历史可能“改坏后又修好”，不满足普通二分定位的单调假设；v1 不做 bisect。

### 4.4 Phase 0 必须验证的新 sidecar 假设

新的独立 sidecar 路径仍有三项真正的前置条件：

1. 用主仓库产生的候选路径集合喂给 sidecar 私有 index，可以正确覆盖 tracked、untracked、ignored、删除、rename、symlink 和 gitlink。
2. sidecar 在完全不配置 main ODB alternate 时，snapshot、diff、restore 和 merge 所需对象全部自包含。
3. 主仓库 rewrite、repack 和 aggressive GC 后，sidecar 中所有受保护 checkpoint 仍可读取和物化。

如果验证失败，回退顺序是：

1. 使用捕获阶段临时 alternate，并在 checkpoint 对外可见前复制和验证完整对象闭包。
2. 如果闭包复制仍不可靠，临时使用主仓库 `refs/thread/*` 保活，并明确接受 `log --all` 污染。
3. 如果仍不能证明数据不丢，停止 workspace backend 实现，不发布静默损坏版本。

### 4.5 checkpoint 写入与跨存储恢复

append-only session log 与 sidecar ref 不能假装原子。固定顺序：

```text
1. 在 sidecar 写 blob/tree/retention commit
2. 验证 tree 与 retention commit 可从 sidecar 独立读取
3. 向 `events.jsonl` 追加一个原子 batch record：
     checkpoint_created
     turn_finished / lane_moved
     branch_moved
     必要时 operation_finished
   并 flush 到磁盘
4. 更新 sidecar refs/keep/<session>
5. 发出内存事件
```

sidecar GC 必须由 harness 独占锁控制，不能在步骤 2 到 4 之间并发运行。启动时执行 reconciliation：

- sidecar 有孤儿对象、session log 无 checkpoint：安全忽略，未来 GC；
- session log 已有 checkpoint、keep ref 落后：根据最新 retention commit 修复 ref；
- session log 引用对象不可读：报告 store corruption，禁止继续 restore/merge。

JSONL 只允许最后一条记录因进程中断而不完整。每条记录包含 `seq`，batch 作为单条记录写入；启动时可以丢弃不完整的尾行，但中间记录损坏必须报错，不能猜测修复。只有在执行外部副作用前必须 durable 的 record 才立即 flush；不为普通只读事件增加复杂的日志协议。

### 4.6 restore 的安全边界

恢复 workspace 的流程：

```text
1. 捕获当前状态为 safety checkpoint
2. 计算目标 tree 与当前 tree 的 write/delete/collision plan
3. 在临时目录物化目标 tree
4. 检查 ignored/out-of-scope 文件碰撞和 workspace drift
5. 写入与删除 scope 内路径
6. 失败时尽力从 safety checkpoint 回滚
7. 成功后移动当前 BranchRef 与对应 lane pointer
```

v1 不宣称 filesystem atomic。目标是：恢复前有安全点、操作有明确计划、失败可诊断并尽力回滚。

---

## 5. Agent loop 与 durable recovery

### 5.1 pi-ai 接口边界

使用 npm 发布的 `@earendil-works/pi-ai`。Phase 0 以实际源码与小型 spike 锁定以下接口：

- `createModels()` 与 provider 注册；
- `models.stream()` / `completeSimple()`；
- `Context`、`Message`、`Tool`、`StopReason`；
- TypeBox re-export：`Type`、`TSchema`、`Static`；
- token estimate、usage、abort 和 faux provider。

不依赖 pi 的 agent 或 coding-agent package；需要的 session/recovery 语义在本项目中独立实现，只对关键恢复边界做必要验证。

CLI 默认以 `process.cwd()` 作为启动位置并解析其所属 Git worktree；安装后用户在任意项目目录直接执行 `thread`，无需传 `--root`。provider、model、endpoint 和鉴权引用属于全局运行配置，默认文件是 `~/.thread/config.json`；可用 `THREAD_HOME` 改变全局配置目录，也可由 CLI/环境变量临时覆盖。全局配置不放入工作区、不参与 thread version；它可以注册使用 `anthropic-messages`、`openai-completions` 或 `openai-responses` 的兼容中转 provider，密钥只引用环境变量名，不写入配置或 session log。该配置层只负责把声明转换为 pi-ai provider/model，不复制 provider 传输实现。

全局运行配置与项目版本状态刻意分离：前者属于本机全局配置；后者继续位于 `<git-common-dir>/thread`，因为 sidecar objects、session tree 和 Checkpoint DAG 是仓库绑定的版本介质。两者不能因为都叫“thread 数据”而混放。

为避免本机同时维护两份模型目录，配置加载采用单向 fallback：若显式配置或 `~/.thread/config.json` 存在，只使用 thread 配置；仅当默认 thread 配置不存在时，读取 pi 的 `~/.pi/agent/models.json`，并从 `settings.json` 取得 `defaultProvider/defaultModel`。遵守 `PI_CODING_AGENT_DIR`。两套 provider 定义不合并，显式配置文件缺失直接报错。

### 5.2 一个普通 turn 的顺序

```text
1. InputRouter 判定为普通消息并锁定当前 BranchRef
2. 锁定 turn_base 的 parent、session head 和 checkpoint id，并异步开始捕获 workspace；快照完成后以一个 batch event 前进 BranchRef，但不倒退正在运行的 lane
3. 预分配 entry/result ids，写 operation_started
4. append user message entry，创建 Turn 记录；UI 可以立即显示该 turn
5. buildSessionContext；必要时执行独立 compaction operation
6. 预分配 assistant entry id 并 enqueue step_attempt；该非 flush 记录与模型请求并行写入
7. 调用 pi-ai stream；首次模型请求与 turn_base workspace 捕获并行，但 append assistant entry、工具执行和 settle 必须等待 turn_base durable，随后 append assistant entry 与 usage
8. 对每个 tool call：
   a. 运行 before_tool_call hook
   b. 预分配 result entry id，写 tool_started
   c. 执行工具
   d. append tool result entry
9. 如果模型需要下一 step，回到步骤 5
10. agent settle 后捕获 workspace tree
11. 以一个 append-only batch event 写 turn_result checkpoint、Turn outcome、operation_finished 并前进 BranchRef，随后 flush
12. 更新 sidecar keep ref并发出 turn_end
```

aborted/failed turn 同样创建 result checkpoint，保存已经发生的部分工作区状态并成为该 branch 的最新 head。

### 5.3 durable record 语义

只实现 v1 用到的 pi record 子集，但字段名、discriminant 和判活逻辑沿用 pi，不发明相似替代品：

- `operation_started.intent.kind`: `run | compaction | navigation`；
- `operation_started.id` 本身就是 operation id；
- `operation_finished.outcome`: `completed | aborted | failed | declined`；
- `step_attempt.step`: `assistant | branch_summary | compaction`；
- `tool_started.replay`: `safe | never`；
- tool record 保存 `assistantEntryId`、`toolIndex`、`toolCallId`、`toolName`、`effectiveArgs` 和预分配的 `resultEntryId`。

启动恢复规则同样沿用 pi：

1. `operation_started` 与 `operation_finished` 配对判断 open operation。
2. 同一 lane 最多允许一个 open operation；多个 open operation 视为持久化损坏，不猜测修复。
3. `safe` 工具可以按确定规则重放；`never` 工具绝不因为缺少 result 就盲目重跑。
4. crash 后先捕获实际 workspace 为 recovery checkpoint，再由 reducer 决定补写失败结果、继续安全步骤或结束 operation。
5. 每个 branch 有一个命名 lane，但同一 Project Session 同时只允许当前 branch 存在一个 open operation；v1 不并行运行多个 branch 或 run queue。

### 5.4 工具框架

工具不感知 branch/commit/checkpoint，也不产生 revision：

```ts
interface AgentTool<TArgs = unknown> {
  name: string;
  description: string;
  parameters: TSchema;
  replay: "safe" | "never";
  execute(args: TArgs, ctx: ToolContext): Promise<ToolResult>;
}
```

首批工具：

| 工具 | replay | 说明 |
|---|---|---|
| `read` | safe | 读取文件，带输出上限 |
| `list` | safe | 列目录 |
| `grep` | safe | 文本搜索，优先使用 rg |
| `write` | never | 写入文件 |
| `edit` | never | 精确文本编辑 |
| `bash` | never | shell 命令，超时、取消、输出上限 |

v1 turn 结束统一扫描 workspace。暂不设计 `ToolEffect`、`touchedPaths` 或逐工具 snapshot；性能数据证明需要后再增加内部优化，不改变工具公共 API。

---

## 6. Thread diff

### 6.1 确定性 facts

```ts
interface ThreadDiffFacts {
  from: { ref: string; checkpointId: string };
  to: { ref: string; checkpointId: string };
  commonAncestorCheckpointId: string | null;
  workspace: {
    files: Array<{
      path: string;
      status: "added" | "modified" | "deleted" | "renamed";
      oldOid?: string;
      newOid?: string;
      additions?: number;
      deletions?: number;
      binary: boolean;
    }>;
  };
  context: ContextDiffFacts;
  factsDigest: string;
}
```

facts 先把两个 VersionRefs 固定解析为 checkpoint IDs，再只读取 sidecar Git objects、session log 投影和 Checkpoint DAG：

- 不读取活工作区；
- 不调用 LLM；
- 不执行扩展 transform；
- 完整 patch 与原始消息通过分页/按路径 API读取；
- `factsDigest` 基于 canonical representation，用于 semantic cache。

### 6.2 自然语言 semantic diff

默认 `/thread diff A B` 给 SemanticRunner 的材料：

```text
A 的 ref metadata + checkpoint Context Capsule
B 的 ref metadata + checkpoint Context Capsule
两者的 checkpoint common ancestor
workspace file stats
在 token budget 内选取的 patch hunks
context structural facts
```

最终输出是 prompt 工程控制的自由文本，不强制固定章节或 JSON schema。它展示在临时结果视图，不 append 到主 session。

如果代码 patch 本身过大：

1. 文件级统计始终完整；
2. patch 按预算选择并明确列出省略路径；
3. v1 不偷偷截断而不告知；
4. 后续可增加 per-file/map-reduce 摘要，但不是首版前置条件。

缓存键至少包含：

```text
factsDigest + fromCapsuleDigest + toCapsuleDigest + promptVersion + model
```

如果 branch head 尚无 capsule，命令先对固定下来的 checkpoint 按需生成；生成期间 branch 继续前进也不会改变本次 diff 的输入。SemanticRunner 失败时 `/thread diff` 返回 facts，而不是让整个命令失败。

---

## 7. Thread merge

### 7.1 分维度编排

merge coordinator 分别调用 workspace 与 context strategy；不暴露一个假定二者语义相同的底层 `merge()`：

```ts
interface WorkspaceMerger {
  plan(baseTree: string, oursTree: string, theirsTree: string): Promise<WorkspaceMergePlan>;
  apply(plan: WorkspaceMergePlan): Promise<string>; // merged tree oid
}

type ContextMergeStrategy = "keep-current" | "summarize";
```

当前 BranchRef 和 incoming VersionRef 先固定解析为两个 checkpoint；Checkpoint DAG 提供 common ancestor。sidecar retention chain 永远不能作为 merge base。

v1 只处理唯一 best common ancestor。出现 criss-cross history、存在多个互不为祖先的最佳 bases 时，返回明确的 unsupported 报告，不尝试递归合成虚拟 base。

### 7.2 `keep-current`

默认策略：

- workspace 执行三方 merge；
- 当前 session head 保持不变；
- incoming branch transcript 不进入当前上下文；
- merge metadata 记录 context strategy，但不向主上下文注入消息；
- context 部分不调用 LLM。

### 7.3 `summarize`

SemanticRunner 输入三个 capsule：

```text
common ancestor capsule
current branch capsule
incoming branch capsule
```

模型自由生成一段“incoming 分支中当前分支尚不知道、但继续工作有用的信息”。输出包装成：

```ts
interface ContextMergeEntry {
  type: "context_merge";
  sourceRef: string;
  sourceCheckpointId: string;
  commonAncestorCheckpointId: string | null;
  content: string;
}
```

与 semantic diff 不同，这段内容会影响 agent 后续决策，因此必须 append 到新 session branch，并被 merge result checkpoint/commit 引用。

### 7.4 v1 merge 流程

```text
preview（无状态修改）
1. 要求当前 branch idle；捕获尚未 checkpoint 的手工 workspace 变化并前进 branch head
2. 固定 current branch head 与 incoming VersionRef，从 Checkpoint DAG 找 common ancestor
3. 计算 workspace merge plan、冲突 facts 和两个 context 策略的含义
4. 打开 merge view；若有 workspace conflict，只允许查看/返回
5. 用户选择 keep-current 或 summarize；选择 summarize 时隔离调用模型生成只读 merge note 草稿

confirm/apply
6. 用户确认；重新验证 current/incoming/base 与 preview 时一致，否则作废 preview 并重新计算
7. 捕获 safety checkpoint，应用 clean workspace tree
8. 必要时 append context_merge entry
9. 创建以 current/incoming checkpoints 为两个 parents 的 merge result checkpoint，并移动当前 BranchRef
10. `/thread merge` 默认为结果 checkpoint 创建一个显式 Thread Commit milestone
11. 为 merge checkpoint 生成 Context Capsule
```

preview 及 semantic note 生成期间都不能改变 workspace、BranchRef 或 session head。第一版只完成 clean merge；遇到 workspace conflict 时返回确定性冲突报告并保持当前工作区不变，`merge --continue/--abort` 状态机以后再加。`/thread merge` 是否允许 `--no-commit` 属于 Phase 5 前可调整的 CLI 行为，底层数据模型不依赖该选择。

---

## 8. 无独立记忆系统

v1 不维护独立于 conversation context 的 project/user memory store，不建立全文检索投影，也不注册 `memory_write`、`memory_search` 或 `memory_archive` 工具。

需要跨长周期保留的项目知识由 compaction 项目状态选择性维护。该状态本身是 SessionEntry，受 checkpoint 和 branch 版本边界约束，因此 restore、diff 与 merge 看到的长期知识和当时的 conversation context 保持一致。原始 session entries 仍是事实源；compaction 状态是可继续工作的有损表示，会在连续压缩中保留仍有效且有未来价值的知识，并覆盖或舍弃过时内容。

旧版本写入 `events.jsonl` 的 `memory_changed` 事件只为日志向后兼容而跳过，不构造运行时投影、不注入模型上下文，也不提供读写接口。canonical log 不为移除此能力而重写。

---

## 9. 单包架构与扩展面

### 9.1 单 package，而不是多包框架

为了保持 mini harness，第一版只建立一个 package：

```text
src/
├── app.ts                 composition root
├── cli/                   bootstrap、flags、输入路由
├── ui/
│   ├── state.ts           UiState、screen reducer、session projection
│   ├── events.ts          UiEvent 与 delta accumulator
│   ├── terminal/          renderer-neutral controller、OpenTUI/Solid view、theme、completion、lifecycle
│   └── plain/             非 TTY/pipe 的纯文本 presenter
├── agent/                 loop、model runtime、context assembler、compaction
├── session/               entries、records、JSONL log、tree、reducer
├── workspace/             sidecar、snapshot、diff、restore、merge
├── revisions/             checkpoints、commits、capsules、refs
├── commands/              /thread built-ins 与 registry
├── tools/                 built-ins 与 registry
├── extensions/            loader、events、public API
└── persistence/           append、flush、tail recovery 与内存投影
```

只有跨边界确实需要稳定替换点时才提取 port/interface，不预先建立 `protocol/core/vcs/store/ext` 多 package 层级。

### 9.2 少量必要接口

```ts
interface SessionStore { /* append/query entries、branch path、lane、records */ }
interface WorkspaceStore { /* snapshot/diff/materialize/merge */ }
interface VersionService { /* resolve refs/checkpoints/branches/commits */ }
interface SemanticRunner { /* one-shot text completion with budget */ }
interface ToolRegistry { /* register/get/list */ }
interface CommandRegistry { /* register/resolve */ }
```

UI 边界直接使用 `UiEvent`、`CommandResult` 和 `UiState` 三个数据类型，不额外创建组件 DI 框架。JSONL session store 和 Git adapter 通过上述 service 边界隔离；其余内部模块优先使用普通函数和具体类型，不为测试替换预先增加抽象。

### 9.3 v1 扩展 API

```ts
interface ExtensionAPI {
  registerTool(tool: AgentTool): Disposable;
  registerCommand(command: ThreadCommand): Disposable;
  on(type: ExtensionEventType, handler: ExtensionHandler): Disposable;
}

type ExtensionEventType =
  | "turn_start"
  | "before_context"
  | "before_tool_call"
  | "tool_result"
  | "turn_end";
```

组合语义固定：

- `turn_start` / `turn_end`：只读通知；
- `before_context`：按注册顺序 transform；
- `before_tool_call`：可改参数或 deny；
- `tool_result`：可 transform 模型可见结果，但原始结果仍保留在 durable record 中。

扩展是受信任本地代码，不做 sandbox。核心工具和 `/thread` 命令名称保留，重复注册报错。未来可以增加事件，但 v1 不先复制 pi 的完整事件面。

---

## 10. v1 append-only 持久化格式

v1 不使用 SQLite。每个 Project Session 只有一个 canonical `events.jsonl`；进程启动时顺序重放，构造 entries、records、turns、Checkpoint DAG、branches、reflog 和 commits 的内存投影。

```ts
type SessionLogRecord =
  | { seq: number; type: "session_created"; session: ProjectSession }
  | { seq: number; type: "entry_appended"; entry: SessionEntry; lane: string }
  | { seq: number; type: "record_appended"; record: DurableRecord }
  | { seq: number; type: "checkpoint_created"; checkpoint: InternalCheckpoint }
  | { seq: number; type: "turn_started" | "turn_finished"; turn: Turn }
  | { seq: number; type: "branch_created" | "branch_moved"; data: BranchEvent }
  | { seq: number; type: "current_branch_changed"; branch: string }
  | { seq: number; type: "thread_commit_created"; commit: ThreadCommit }
  | { seq: number; type: "batch"; events: SessionLogEvent[] };
```

实现保持简单：

1. `seq` 在单进程内单调递增；v1 用 Project Session 文件锁拒绝第二个 writer，不实现多 writer consensus 或数据库式 CAS。
2. 一组必须共同生效的投影变化写成一条 `batch` JSONL record，例如 `checkpoint_created + branch_moved + turn_finished`。
3. 每条 record 必须在一次 append 中编码为单行；需要先于副作用落盘的 `operation_started` / `tool_started` 在执行副作用前 flush。
4. 启动时允许忽略并截断唯一一条不完整的尾行；中间 JSON、`seq` 连续性或引用关系损坏时停止并报告 corruption。
5. replay reducer 同时建立按 id、parent、branch、turn 和 commit 的 Map；v1 不做持久化二级索引。
6. capsule 与 semantic diff cache 是 `cache/` 下按 key 命名的派生文件，可以删除和重建，不写入 canonical log。
7. Checkpoint DAG 仍是 branch/diff/merge ancestry 的唯一事实源；Thread Commit 只是 checkpoint annotation。
8. Project Session idle 时，当前 branch 的 lane leaf 必须等于其 head checkpoint 的 `sessionHeadId`。
9. 旧版日志中的 `memory_changed` event 在 replay 时被兼容性忽略，不进入当前事件 schema 或任何运行时投影。

这不是承诺永远不用数据库。若真实 Project Session 的日志规模导致启动重放或历史查询出现可测瓶颈，v2 可以引入 SQLite 作为可重建索引，或迁移为 canonical store；v1 不提前承担 migration、schema 和双写复杂度。

---

## 11. 实施阶段

### Phase 0：三项技术 spike

#### 0A. pi-ai

- 从本机 package 确认 exports 与 provider 初始化方式。
- 用一个 faux provider smoke 跑通 stream、tool call、abort、usage 和 one-shot semantic call。
- 确认 Bun 版本、Solid JSX preload/plugin 和 TypeScript 类型检查方式。

#### 0B. workspace sidecar

- 建立独立 bare sidecar + private index prototype。
- 用一个综合 fixture 覆盖 tracked、tracked-but-ignored、untracked、ignored、删除和 rename；平台允许时顺带覆盖 symlink/gitlink。
- 在同一个必要的集成检查中跑通 snapshot → diff → 临时物化 → 工作区 restore。
- 验证主仓库 rewrite/repack/GC 后 sidecar 完整。这是防止版本静默丢失的发布门槛，不能省略。

#### 0C. append-only log durability

- 用最小 prototype 确认单调 `seq`、单行 batch append、flush 和尾部半行恢复。
- 只模拟两个会导致数据丢失或重复副作用的关键窗口：log 已引用但 keep ref 落后；`tool_started(replay=never)` 已 flush 但 tool result 缺失。
- 验证 reconciliation 能修复 lagging keep ref，且绝不重跑 `replay=never` 工具。

退出条件：上述数据安全门槛有可重复的最小集成检查；任一假设失败就采用既定 fallback，不进入正式实现。除这些会造成数据丢失或重复副作用的路径外，Phase 0 不扩展测试矩阵。

### Phase 1：session 与最小 agent loop

- 建立单 package、CLI 和 append-only session log。
- 增加固定版本的 Bun、`@opentui/core`、`@opentui/solid` 与 `solid-js`；只允许 terminal adapter/build scripts import renderer，并建立 full-screen TUI 与 plain fallback。
- 把 `onTextDelta` 扩展为结构化 `UiEvent`，让输入路由器补充 command/head 事件；实现有界 transcript scrollbox、Textarea、运行状态、Footer 和应用内二级 screen，text delta 以 16–33ms 合批。
- TUI 激活时独占 stdout；实现 raw mode/terminal protocol 的 `try/finally`、signal 和 crash cleanup，工具输出与 debug log 不得绕过 renderer。
- 实现 Project Session 自动创建/恢复、append-only entries/records、命名 lanes 与 branch traversal。
- 实现 `buildSessionContext()` 和 compaction entry 语义。
- 实现按完整请求预算触发的分层 compaction、完整交互尾部保留，以及 `/compact` 手动入口。
- 实现 MainAgentRunner、CompactionRunner、SemanticRunner 三条调用路径。
- 实现工具 registry 与 `read/list/grep/write/edit/bash`。
- 实现 pi 语义的 operation recovery 子集。

退出条件：faux provider 可以在 full-screen TUI 中完成多 step tool turn，稳定 transcript 与 live turn 正确交接，应用内二级 screen/plain fallback 可用；正常退出和中断后终端状态恢复；重启后自动回到同一个 Project Session，session tree 和 open-operation 判定一致，`replay=never` 工具不盲目重放。

### Phase 2：Checkpoint DAG、BranchRef 与历史消息恢复

- 实现 workspace snapshot service 和 genesis checkpoint。
- 建立 `main` BranchRef；普通消息前创建 turn base checkpoint，settle 后创建 result checkpoint，并通过 batch event 自动前进当前 branch。
- 实现 `/thread branches`、`branch`、`switch` 和 `reflog`。
- switch 前捕获手工 workspace 变化，确保离开的 branch 保留最新状态。
- 启动时检测当前工作区 drift；无 open operation 时把人工变化接到当前 branch，有 open operation 时交给 recovery reducer。
- 维护 `Turn.userEntryId → baseCheckpointId` 映射。
- 实现分页 history screen 和 plain 模式的 `/rewind <turn-id>` 入口；选择消息后显示恢复前确认信息。
- 实现 `/clear` 的纯显示隐藏锚点；不提供主动遗忘整个 context 的命令。
- 实现 workspace/context/both restore、safety checkpoint、BranchRef 移动和分支继续。
- 覆盖 completed/aborted/failed/crashed turn。

退出条件：在同一个 Project Session 中可以创建和切换 branch；每条 branch 恢复自己的代码和 compaction-aware context；history screen 选择任意历史用户消息后恢复到执行前，旧 head 可由 reflog 找回。

### Phase 3：显式 Thread Commit 与 Context Capsule

- 实现 VersionRef 解析、checkpoint ancestry、HEAD、短 ID、`status/log/show`。
- 实现 `/thread commit`，把当前 branch checkpoint 标记为不可变里程碑。
- commit 成功后为其 checkpoint 从 compaction-aware context 生成固定预算 capsule。
- capsule 失败不影响 commit，并可手动/按需重试。
- 实现 `/thread restore <ref>`。

退出条件：branch 和 commit 都能在重启后稳定解析到 checkpoint；每个成功 capsule 的输入不包含无限原始 transcript；无模型时 branch/commit/restore 仍可工作。

### Phase 4：Thread diff

- 实现 workspace tree diff、patch 分页和 ContextDiffFacts。
- 实现 branch/commit 任意组合的 `/thread diff --facts`。
- 实现 semantic prompt assembly、token budget、临时结果输出和 cache。
- 实现 diff screen：semantic summary 在前，context/workspace facts 在后；支持滚动、复制和 `Esc` 返回，view 状态不写入 session。
- branch head 缺少 capsule 时，固定 checkpoint 后按需生成并缓存。
- 保证 diff 调用及其输出不进入主 session。
- 实现 capsule 缺失/失败、代码 diff 超大和 semantic provider 不可用时的降级。

退出条件：两个 VersionRefs 始终可得到确定性 facts；正常情况下可得到以代码 + context 为材料的自然语言 diff。

### Phase 5：clean merge 与两种 context 策略

- 实现 Checkpoint DAG common ancestor。
- 使用 sidecar Git objects 完成 workspace 三方 merge plan。
- 实现无修改的 merge preview screen，用户在其中选择 `keep-current` 或 `summarize`，再次确认后才 apply。
- 实现 `keep-current`。
- 实现三 capsule 输入和带来源的 `context_merge` entry。
- apply 前重新验证 preview 固定的 refs/head；过期 preview 必须重算，不能对新状态应用旧计划。
- clean merge 创建双 parent checkpoint、前进当前 BranchRef，并默认附着一个 Thread Commit milestone；conflict 返回报告且不修改当前工作区。
- 为 merge checkpoint 生成 capsule。

退出条件：两条 session branches 即使没有预先显式 commit 也能在 merge screen 中预览并 clean merge；两个 context 策略行为可验证；semantic merge note 只在用户显式选择并确认后进入主上下文。

### Phase 6：extensions 与 hardening

- 实现 tool/command registration 与五个 v1 extension events。
- 增加 `fsck` 内部 API：检查 entry parent、Checkpoint DAG、BranchRefs、commit annotations 和 sidecar keep ref。
- 增加 session 删除后的显式 GC；不在活跃 session 中自动删 turn checkpoints。
- 对实际遇到的 Windows 文件占用、长路径、取消或 human edit 问题做定点修复，不预先建立平台组合测试。

退出条件：第三方本地扩展能注册一个工具和一个 `/thread` 命令；fsck 能发现跨 session log/sidecar 的破坏。

---

## 12. 最小验证原则

v1 不追求覆盖率数字，也不为普通 getter 或纯格式化输出建立穷举矩阵。默认验证方式是 TypeScript 类型检查、数据安全集成检查、OpenTUI 定点字符快照、构建 smoke 和真实 TTY lifecycle；渲染所有权、screen-mode 转换或终端恢复出现过真实风险时，应保留对应回归检查。

### 12.1 发布前仅保留的必要检查

1. **sidecar 数据安全**：一个综合 fixture 完成 snapshot → mutate → restore → resnapshot，并在主仓库 rewrite/GC 后证明受保护 tree 仍可读取。
2. **durable recovery**：事件日志尾行中断可恢复；已 flush 的 `tool_started(replay=never)` 在重启后不会重复执行工具。
3. **最小版本与 TUI 闭环 smoke**：用 faux provider 在 full-screen TUI 中完成一个含 thinking、流式 Markdown 和工具调用的 turn，确认 live block 组件身份稳定且完成后由 durable transcript 接管；打开 model/history/diff/merge screen、resize、返回并中断一次，确认 cursor/raw mode 被恢复；然后创建 thread branch、切换、commit、diff facts、restore 和一次 clean merge，确认重启后仍能继续当前 branch。plain 启动并退出一次。
4. **破坏性操作安全**：restore 前产生 safety checkpoint；workspace merge conflict 不修改当前工作区。

这些检查优先写成少量端到端或集成脚本，不把同一行为拆成大量单元测试。某个真实 bug 若可能再次造成数据丢失、重复副作用或工作区破坏，再为它补一个定点回归检查。

### 12.2 明确不做的测试工作

- 不做随机 session tree / Checkpoint DAG 性质测试。
- 不对每一种 completed/aborted/failed 组合建立测试矩阵。
- 不穷举 provider、模型、操作系统和文件类型组合。
- 不为 semantic 文案、capsule 内容或 prompt 输出写脆弱断言。
- 不做 terminal/颜色/宽度/键位的组合矩阵；只保留 renderer ownership 与关键 screen transition 的小型字符快照，不保存大幅 screenshot golden。
- 不建立 benchmark suite 或覆盖率门槛；CI 只覆盖 Bun check/test/build，release 才使用按平台原生编译矩阵。
- 不预先做故障注入框架；只保留 12.1 中两个直接关系数据安全的 crash case。

### 12.3 性能边界

- 每个 turn 默认两次 workspace snapshot；v1 接受 turn 边界全量扫描。
- Git 路径操作必须 batch，避免为每个文件启动一个子进程。
- capsule 只在显式 commit 或 semantic diff/merge 需要时生成。
- semantic prompt 有硬 token budget，并明确报告省略材料。
- session transcript 只挂载最近 8 次 user-led interactions，live tree 只额外挂载当前 turn；常驻组件数不能随 Project Session 总长度增加。
- text delta 每 16–33ms 最多触发一次 UI flush；tool body 默认折叠，resize 只重排当前 transcript window。
- 不为 v1 建专门性能测试；只有真实项目中出现可感知延迟，再测量并优化具体热点。

---

## 13. 主要风险与对策

| 风险 | 对策 |
|---|---|
| sidecar snapshot 依赖 main ODB 后对象被 GC | Phase 0 强制无 alternate 自包含验证；失败走闭包复制 fallback |
| 每 turn 两次扫描在大仓库变慢 | 首版保留简单正确性；后续只在内部增加 path hints/fsmonitor，不改工具 API |
| session log 已记录 checkpoint 但 keep ref 落后 | 固定写序、sidecar GC 锁、启动 reconciliation |
| BranchRef 与 lane leaf/checkpoint 不一致 | 相关变化写入单条 batch record、branch reflog、启动 reducer 修复或拒绝继续 |
| Project Session 日志长期增长导致启动变慢 | v1 先保持单文件和内存投影；出现真实瓶颈后在 v2 引入分段、projection snapshot 或 SQLite 索引 |
| OpenTUI/Solid API 或 native ABI 变化 | 精确固定 OpenTUI 0.5.7 与 Solid 1.9.12；依赖局限在 terminal adapter；升级必须经过字符快照、build 和真实 TTY smoke |
| 单文件构建漏掉 native core/parser assets | Bun compile 从各平台原生 runner 构建；最终产物在独立目录执行 `--help` 和 TTY lifecycle，不依赖源码 `node_modules` |
| 项目级 transcript 让实时树越来越慢 | transcript projection 固定为最近 8 次用户主导交互并启用 viewport culling；tool 历史默认摘要 |
| 流式 token 造成 render storm或 Markdown 闪烁 | delta accumulator 以 16–33ms 合批；append-only live blocks 用稳定索引保留 renderable，只更新当前 leaf 的 content |
| 工具或扩展直写 stdout 破坏全屏画面 | TUI 激活时 renderer 独占 stdout；shell 输出 capture；debug 写 sidecar log；退出后再显示 fatal error |
| 异常退出遗留 raw mode、隐藏 cursor 或键盘协议 | 所有 start/stop 成对放入 `try/finally`，并覆盖 SIGINT/SIGTERM 与 uncaught exception；发布 smoke 必查 terminal restoration |
| 旧终端、SSH 或自动化环境不支持交互 TUI | 非 TTY 自动 plain fallback，并提供 `--tui plain`；键盘路径完整，鼠标和高级 keyboard protocol 只是增强 |
| restore 覆盖用户未保存或 ignored 文件 | restore 前 safety checkpoint、collision plan、scope 外路径拒绝覆盖 |
| compaction/capsule 丢失语义细节 | raw entries 永久保留；capsule 标记为有损；事实 diff 可分页查看原文 |
| Project Session 长期反复 compaction 导致目标逐渐模糊 | compaction 项目状态选择性传递稳定事实，用较新证据和日期覆盖过时内容；raw entries 永久保留，并允许用户查看/修正摘要 |
| 两个 capsule 让 semantic diff 产生幻觉 | 同时提供确定性 workspace/context facts；输出定位为语义说明而非事实源 |
| 大代码 patch 放不进 semantic prompt | 完整 stats + 明确的 budget/omission；按路径展开；后续再做分块摘要 |
| merge note 把错误信息注入主上下文 | 只在显式 `summarize` 时生成；带 source/base provenance；保留 `keep-current` 默认 |
| shell 启动后台进程后继续改文件 | v1 禁止 detached execution 或明确报告 unsupported |
| 外部 API/数据库副作用无法恢复 | 不纳入版本承诺；工具文档和 UI 明确标记 |
| checkpoint、branch、commit 概念混淆 | UI 固定表达：checkpoint 是状态节点、branch 是移动指针、commit 是里程碑；普通 log 默认隐藏 turn 节点 |
| thread branch 被误认为 Git branch | 所有命令固定在 `/thread` namespace；status 同时显示 thread branch 与 Git branch；绝不隐式移动主仓库 HEAD/index/refs |
| 为扩展性提前搭建过多抽象 | 单 package；只保留五个事件和少量必要 service interface |

---

## 14. v1 明确不做

- SQLite、migration、FTS 和数据库持久化层；列入 v2 候选，不在 mini harness 首版实现。
- 每个工具调用一个 revision 或 versioned effect receipt。
- 独立于 Session context 的第二套 memory store、检索系统和 memory tools。
- model/provider/system prompt/tool/extension environment manifest。
- staging area、`add`、stash、rebase、cherry-pick、revert、bisect 等完整 Git 复刻。
- 自动拼接或逐消息合并两条 context transcript。
- workspace conflict 的交互式 `merge --continue/--abort`；首版仅 clean merge。
- 确定性重放 LLM 输出。
- 回滚网络、数据库、进程和工作区外副作用。
- filesystem-level atomic restore/merge 承诺。
- ignored 文件、空目录和子模块内部状态快照。
- 多 agent、并行执行多个 branch/lane、subagent、MCP 和插件 sandbox。
- 自研 React reconciler/Yoga/cell renderer，或 vendor/fork OpenTUI native core；终端底层由固定上游版本负责。
- Claude Code/OpenCode 级的全历史平滑 virtual scroll、文本选择引擎、diff conflict editor、command palette、主题市场、图片协议和 IDE 式鼠标交互。
- 为 terminal/plain 模式维护另一套业务状态；它们只投影同一个 UiState/CommandResult。
- `blame-step`、`trace`、`bisect` 或逐工具回归定位。

---

## 15. v1 完成定义

以下条件全部满足，才算 mini harness 的版本闭环完成：

1. 普通多 step agent loop 可运行，Project Session append-only、可压缩、可崩溃恢复，且不重复执行 `replay=never` 工具。
2. 重启默认回到同一个项目 session 和当前 branch，用户无需重新建立项目背景。
3. 每个 turn 都有 base/result checkpoint 并自动前进 BranchRef；选择历史用户消息能恢复到执行前。
4. 用户可以创建和切换 session branch，代码与 compaction-aware context 始终一起恢复。
5. 用户可以通过 `/thread commit` 为任意 branch checkpoint 创建显式里程碑，没有 staging。
6. Context Capsule 绑定 checkpoint：commit eager、branch semantic operation lazy；摘要失败不影响状态历史。
7. `/thread diff` 可以比较 branch/commit 任意组合，有完全独立于 LLM 的 facts，并能在临时视图输出自然语言说明。
8. `/thread restore` 可以恢复 VersionRef；恢复前保留 safety checkpoint 和 reflog，旧 session path 不被删除。
9. `/thread merge` 可以直接合并 branch head，完成 clean workspace merge，并支持 `keep-current` 与 `summarize` 两种 context 策略。
10. sidecar 在主仓库 rewrite/GC 后仍可独立读取所有受保护 checkpoint。
11. 长期项目知识通过版本化 compaction 项目状态传递，不依赖外部 memory 系统；扩展可以注册工具、命令和最小事件钩子。
12. 所有 LLM 参与点都明确区分：主会话、compaction、临时 semantic call，以及唯一会写回上下文的 merge note。
13. TTY 默认提供 full-screen TUI：可见 transcript 有界且 live Markdown 增量更新；model/history/diff/merge 是可返回且不污染 session 的应用内 screen，所有退出路径会恢复 cursor、raw mode 与键盘协议。
