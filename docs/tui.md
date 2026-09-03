# Thread 的全屏 TUI

全屏 TUI 是 Thread 的主交互面。它不实现 Session Tree、compaction 或工具执行，只把当前 live path、进行中的 turn 和临时面板画在同一棵持久渲染树上。TTY 默认进入这个界面；非 TTY 或 `--tui plain` 走 `src/ui/plain`，与这里无关。

实现遵循四条约束：长时间阅读不刺眼；transcript 本身尽量少用边框和底色；工具结果在完成后立刻可见，但不默认占满屏幕；流式更新不能把已经画完的回合拆掉重排。

## 主题

配色集中在 `src/ui/terminal/theme.ts`。启动时读取终端的 light/dark，一次生成 `ThreadViewResources`（主题 + Markdown syntax style），运行期间不再切换。配置文件里没有自定义主题。

暗色是主路径：背景是深海军蓝，不是纯黑；文本是灰白，不是高对比冷白。层次靠明度，不靠饱和度：

```text
background  #0B0E14    整屏底
surface     #161B22    浮层、欢迎卡、页脚条
surfaceHigh #1C2128    输入框、选中行
text        #B4BCC6    主文本
softText    #8B93A0    次要文本、工具参数
muted       #6B7280    辅助说明、成功的工具输出
faint       #5B6369    耗时、图标、提示键
thinking    #9B8FB8    流式思考
thinkingDim #8578A8    已完成的思考预览
accent      #C8936D    标题、模型名、工具名
spark       #C09850    进行中：spinner、忙碌边框
sparkAlt    #5FA068    当前选中行
success / warning / error   语义色，同样低饱和
border / borderStrong       轻边框只给卡片和浮层
```

`accent`、`spark`、`sparkAlt` 只在需要拉注意力时出现。内联代码用 `accentDim` 前景加 `surface` 背景；代码块里的 keyword / string / type 走同一套语义色。亮色主题存在，角色相同，数值按浅底重写。

## 主屏幕

`SessionScreen` 是一张相对定位的整屏：上方是 transcript 或欢迎页，下方固定状态行、输入框和页脚。输入区高度随内容在 1–4 行之间变化，transcript 的底边跟着让。

```text
┌──────────────────────────────────────────┐
│  transcript（sticky 到底，无滚动条）      │
│                                          │
│  ┌ 浮层（命令补全 / 模型 / rewind / ask）┐│
│  └──────────────────────────────────────┘│
│  status · 耗时 · esc interrupt            │
│  ┌──────────────────────────────────────┐│
│  │ ❯ composer                           ││
│  └──────────────────────────────────────┘│
│  ⊙ session  ⎇ branch  █ meter  ⚡ cache   │
└──────────────────────────────────────────┘
```

欢迎页只在 transcript 为空且没有 live turn 时出现：tiny ascii 「thread」、一句 Session Tree 说明、以及 `/agent` `/thread` `/compact` `⇧⇥` 的提示。

临时文档（`/thread history` 一类 ephemeral view）不叠在 session 上，而是换成 `DocumentScreen`：顶栏标题、Markdown 滚动区、底栏操作提示。这份内容不写入 Session Tree。

## Transcript

历史是扁平的 `TranscriptItem` 列表。渲染前按用户消息切成回合：一条用户卡片，后面跟上该回合的思考、工具、回复、compaction 和 worker 卡片。

- 用户消息是左对齐圆角卡片，`maxWidth` 78%，先写一行淡色 `you`。
- Agent 回合是 `TurnBlock`：左侧 `▍thread` 标题，没有底色，也没有外框。
- 回复是 Markdown。OpenTUI 0.5.7 只在 `streaming` 模式下绘制 markdown 内容，因此历史回复同样开着 streaming；围栏 info 若是文件路径，会收成 OpenTUI 认识的 language id。
- 思考在流式阶段用 spinner + `thinking` 色斜体；完成后改成 `thinkingDim`，默认最多约 5 行（按 40 列估算折行），点击整块展开。短思考没有折叠控件。
- Compaction / 中断是一行 `◇` 摘要；有 detail 时点击展开 Markdown。
- Worker 任务是圆角卡片，边框颜色跟 `running` / `completed` / `failed` / `cancelled` 走。默认只显示标题和状态摘要，点击后在卡片内复用 live block 渲染 trace。

`projectTranscript` 每次从 session log 重建 item。如果把新对象直接交给 Solid 的 `<For>`，已完成回合的 markdown 会在每个 delta flush 时卸掉重挂，表现为旧回复重新折行、sticky 滚动跳动。因此分组结果会和上一帧对身份：内容没变的 group 复用原对象。Live 块是追加式的，用 `<Index>` 保住每一块的 renderable。

## 工具输出

工具执行器在 `tool_finished` 里带上模型可见的 `content`；失败时另外给截断后的 `error`。UI reducer 把 `content` 写进 `LiveBlock.content`，把状态写进 `LiveTool`。`LiveTool` 本身不保存成功结果，成功输出只活在 block 上。

运行中只显示一行：spark spinner、accent 工具名、截断后的主要参数（`path` / `command` / `pattern` / `query`）。块在完成后才画出输出。历史项和 live 项用同一套视觉：

- 成功 `✓` + `success` 色；失败 `✗` + `error` 色。
- 输出无边框、无底色，左缩进；成功用 `muted`，失败用 `error`。
- 可解析的 JSON 会做 2 空格格式化；其它内容按原文显示。头部不标 `json` / `code`。
- 超过 5 行默认折叠，左侧点击展开。未完成的 live 工具不能展开。

委派类工具（`delegate_tasks` 等）不进入普通工具行，而是变成上面的任务卡片。

## 浮层

模型列表、次级 Agent 开关、rewind、ask 和 `/` 补全都不是全屏接管。它们是输入框上方的同一类小面板：左右各留 1 列，圆角，`surface` 底，`borderStrong` 边。Ask 用 `spark` 边框，因为它在等用户回答。

共同语言：

- 标题 `accent` + bold，带一个功能图标（`⚙` `⎌` `ⓘ`）。
- 选中行 `surfaceHigh` 底、`sparkAlt` 字、`▸`。
- 当前已生效项用 `●` 和 `accent`，与光标选中分开。
- 列表窗口最多 8 行（ask 的选项由工具上限收在 4 个）。
- 方向键只改 view 里的 selection signal，不经 controller `notify()`，避免整棵 session 树跟着闪。

## 状态与页脚

状态行在输入框上方。忙碌时左侧是共享时钟的 braille spinner，右侧提示 `esc interrupt`。文案来自当前 activity（thinking / 工具名 / compacting / workers），结束后留下 `worked <duration>` 或 notice。

页脚是一条 `surface` 底的单行，按终端宽度裁剪：

| 宽度 | 显示 |
| --- | --- |
| 任意 | `⊙` 完整 session id（至少 16 列，`flexShrink=2`）、模型名（不收缩） |
| ≥ 72 | 8 格 context meter + 百分比 |
| ≥ 96 | `⚡ cache`；若上次未命中，追加 `↓token` 和原因（`idle` / `model` / `prefix`） |
| 有 git | `⎇` 分支名（最先被压缩） |
| 模型支持思考 | `· thinkingLevel`；宽屏再给 `⇧⇥` |

Meter 用 `█▓▒░` 做 8 格含半格。颜色按用量：`< 60%` muted，`60–80%` warning，`≥ 80%` error。自动 compaction 触发点是 78%，所以正常使用里 meter 多半停在 muted 或 warning。Cache 尚未测到时写 `cache —`，不用 `0%`。

## 渲染约束

TUI 和 agent 执行解耦。所有展示事件经 `safeUiEvent` 进入 `UiEventBatcher`：约 33ms 一帧，相邻的 text/thinking delta（含 worker trace）会拼成一条。渲染失败不影响持久执行。

动画共用一个 100ms 时钟。状态行耗时和所有 spinner 读同一个 signal，避免每个工具自己 `setInterval` 把 OpenTUI 顶到 max FPS。

Transcript 滚动区开启 `viewportCulling` 和 sticky-to-bottom，垂直滚动条隐藏。鼠标滚轮有单独的加速度曲线。

## 代码位置

- `src/ui/terminal/theme.ts`：色板、syntax style、meter、图标、JSON 探测。
- `src/ui/terminal/session-screen.tsx`：主屏幕、页脚、浮层、输入框。
- `src/ui/terminal/transcript.tsx`：欢迎页、回合分组、思考 / 工具 / 回复。
- `src/ui/terminal/transcript-projection.ts`：session log → `TranscriptItem`。
- `src/ui/terminal/view.tsx`：挂载、键盘、overlay selection。
- `src/ui/terminal/spinner.tsx`：共享动画时钟。
- `src/ui/events.ts` / `src/ui/state.ts`：展示事件、live 状态、`tool_finished.content`。
- `src/agent/tool-call-executor.ts`：把工具输出送进 UI。
