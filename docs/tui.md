# Thread 的全屏 TUI

全屏 TUI 是 Thread 的主交互面。它不实现 Session Tree、compaction 或工具执行，只把当前 live path、进行中的 turn 和临时面板画在同一棵持久渲染树上。TTY 默认进入这个界面；非 TTY 或 `--tui plain` 走 `src/ui/plain`，与这里无关。

实现遵循四条约束：长时间阅读不刺眼；transcript 本身尽量少用边框和底色；工具结果在完成后立刻可见，但不默认占满屏幕；流式更新不能把已经画完的回合拆掉重排。

## 主题

配色集中在 `src/ui/terminal/theme.ts`。启动时读取终端的 light/dark，一次生成 `ThreadViewResources`（主题 + Markdown syntax style），运行期间不再切换；未取得终端模式时使用暗色。配置文件里没有自定义主题；plain 模式不受这套配色影响。

薄荷色只用于前景，不铺绿色背景。整屏、面板和输入框保留原来的中性底色：暗色依次为 `#0B0E14`、`#161B22`、`#1C2128`，亮色依次为 `#FFFFFF`、`#F6F8FA`、`#EFF1F3`。卡片和浮层沿用轻边框，正文与工具结果不增加色块，内联代码也不加底色。

内容层次主要靠文字明度和少量协调的色相区分。Markdown 标题与欢迎标志使用更鲜明的薄荷色；每个回合的 `thread` 名称使用柔和的灰薄荷色和常规字重。工具名使用低饱和灰橙色 `toolNameAccent`，页脚模型名保留原来的橙色 `nameAccent`；二者都使用常规字重，避免反复出现的标签过于醒目。

正文保持中性色，不把整段回答染绿。工具调用信息（命令、路径、参数）的视觉强度介于主正文和次要正文之间。普通工具输出展开后使用次要正文色，折叠预览和耗时继续减弱，让调用信息与结果保持层次。运行提示、状态行 spinner 和输入框运行时的边框统一使用低饱和灰蓝色 `runningAccent`，保留忙碌状态的辨识度，又避免原先青蓝色过于鲜艳；空闲时输入框恢复中性边框。

| 用途 | 色彩角色 | 暗色 | 亮色 |
| --- | --- | --- | --- |
| Markdown 标题、欢迎标志 | `accentStrong` | `#ADE6CF` | `#165E4B` |
| 链接、操作强调 | `accent` | `#80CCB2` | `#26765F` |
| 页脚模型名 | `nameAccent` | `#C8936D` | `#EA580C` |
| 工具名 | `toolNameAccent` | `#B49782` | `#966D4F` |
| 回合名称、内联代码、欢迎页命令提示 | `accentDim` | `#70A996` | `#4A7766` |
| 主正文 | `text` | `#C0CACF` | `#2B3B3E` |
| 工具调用信息：命令、路径、参数 | `toolCallText` | `#AAB7BE` | `#3D4F54` |
| 引用、展开的普通工具输出 | `softText` | `#98A7AE` | `#4F626A` |
| 工具预览、辅助说明 | `muted` | `#7D8B95` | `#63747C` |
| 耗时、提示键 | `faint` | `#606D78` | `#75838D` |
| 流式思考 | `thinking` | `#9FAAD0` | `#5B6E93` |
| 已完成的思考预览 | `thinkingDim` | `#7F8CAA` | `#6B7891` |
| 运行提示、状态行 spinner、输入框忙碌边框 | `runningAccent` | `#9BB8BF` | `#446770` |
| 工具与面板活动标记、ask 边框、光标 | `spark` | `#83C4D4` | `#2E7385` |
| 当前选中行文字 | `sparkAlt` | `#B4DEC1` | `#386F52` |
| 成功状态 | `success` | `#90BD9C` | `#497653` |
| 警告、上下文用量提示 | `warning` | `#C6AB78` | `#916B34` |
| 错误状态 | `error` | `#D48F98` | `#A75261` |

薄荷、青蓝和雾蓝紫用于区分标题、活动和思考；成功用柔和鼠尾草绿，警告与错误分别保留香槟金和玫瑰红。代码里的 keyword / function / type 分别沿用薄荷、青蓝和雾蓝紫，字符串使用成功色。输入框的文字选择只用中性灰反选底色，确保选区可见，不引入大面积彩色背景。

## 主屏幕

`SessionScreen` 是一张相对定位的整屏：上方是 transcript 或欢迎页，下方固定状态行、输入框和页脚。输入区高度随内容在 1–4 行之间变化，transcript 的底边跟着让。

```text
┌──────────────────────────────────────────┐
│  transcript（sticky 到底，无滚动条）      │
│                                          │
│  ┌ 浮层（命令补全 / 模型 / rewind / ask）┐│
│  └──────────────────────────────────────┘│
│  status  耗时      +N −N   esc interrupt  │
│  ┌──────────────────────────────────────┐│
│  │ image · 1280×720 png                 ││
│  │ ❯ composer                           ││
│  └──────────────────────────────────────┘│
│  ⊙ session  ⎇ branch  █ meter  ⚡ cache   │
└──────────────────────────────────────────┘
```

输入框上方的状态行居中显示本轮修改统计 `+N −N`，分别使用 diff 的新增／删除文字色，不加标签。工具完成后实时更新；两项都为零时隐藏，Turn 结束后保留，下一轮开始时清零。左右状态区等宽，为统计保留居中位置，较长的状态文字截断显示，不增加输入区高度。

统计累计本轮成功 `edit`／`write` 返回的实际增删行数，包含本轮 Worker 卡片中的修改；同一文件多次修改分别累计，并非整轮前后的净差异。结束后从对应 Turn 的已保存工具结果恢复，切换 Session 或 rewind 时跟随当前 live tip。这里只使用已有的 diff 元数据，不扫描 Git，也不估算 Bash、自定义工具或未生成 diff 的写入。

欢迎页只在 transcript 为空且没有 live turn 时出现：tiny ascii 「thread」，以及两行项目定位文案「One project. One Session Tree.」「Your interactions are the project's memory.」。命令指引保留两行：第一行说明 `/session` 接续工作和 `/thread search <query>` 搜索历史；第二行说明 `/agent` 选择模型与启用 Agent。第三行单独提示 `Ctrl+V` / `Alt+V` 贴图和 `Shift+Tab` 切换 thinking level。

图片附件不进入 textarea。Ctrl+V / Alt+V 从 host clipboard 读图，输入框上方用一行宽高和格式确认；处理期间显示 `reading clipboard…`，避免回车抢先提交；空输入框按 Backspace 删除最后一张。Windows Terminal 会拦截 Ctrl+V，此时 Alt+V 是可靠的贴图键。回车后附件与文字组成同一条多模态用户消息。完整链路见 [`tui-image-paste.md`](./tui-image-paste.md)。

文字可用鼠标拖选，再按 `Ctrl+C` 或 `Alt+C` 复制；输入框通过键盘选中的文字也支持复制。选区存在时，`Ctrl+C` 优先复制，不中断任务、清空输入或退出；`Esc` 先取消选区。没有选区时，`Ctrl+C` 保留原有的中断／清空／退出行为，`Alt+C` 不执行操作。终端若拦截复制快捷键，可用 `Alt+C`。欢迎页和文档页提供复制提示。

复制复用 OpenTUI 的 clipboard service：本地优先写入系统剪贴板，后端不可用或失败时尝试终端 OSC 52；远程会话仅向终端请求复制。系统写入成功和已向终端发送请求分别提示，失败时保留选区供重试。鼠标选区保留到再次点击或按 `Esc`；拖选工具结果、思考、compaction 或 Worker 标题不会触发展开／折叠。

每个回合只在最后一条无工具调用的最终回复末尾显示 `⧉ copy` 按钮，中间说明和带工具调用的回复不显示；Worker trace 同样只为最后一条无工具调用的回复显示按钮。按钮在完整回复落入历史后出现，流式输出、失败或中断的模型响应、空正文均不显示。最终回复含多个文本块时，仅在最后一个文本块下方放一个按钮，点击复制整条回复的原始 Markdown（包括屏幕外正文、代码块和链接），不包含思考、工具输出或按钮文字，无需先选中文字。写入期间显示 `… copying`，成功后显示两秒 `✓ copied`；仅向终端发送了复制请求时显示 `↗ sent`，失败时显示 `! retry copy` 并在状态区说明原因。拖选经过按钮不会触发复制，按钮也不会抢走输入框焦点。

临时文档（`/thread history` 一类 ephemeral view）不叠在 session 上，而是换成 `DocumentScreen`：顶栏标题、Markdown 滚动区、底栏操作提示。这份内容不写入 Session Tree。

## Transcript

历史是扁平的 `TranscriptItem` 列表。渲染前按用户消息切成回合：一条用户卡片，后面跟上该回合的思考、工具、回复、compaction 和 worker 卡片。

- 用户消息是左对齐圆角卡片，`maxWidth` 78%，先写一行淡色 `you`。
- Agent 回合是 `TurnBlock`：左侧 `▍thread` 标题，没有底色，也没有外框。
- 回复是 Markdown。OpenTUI 0.5.7 只在 `streaming` 模式下绘制 markdown 内容，因此历史回复同样开着 streaming；围栏 info 若是文件路径，会收成 OpenTUI 认识的 language id。
- 思考在流式阶段用 spinner + `thinking` 色斜体；完成后改成 `thinkingDim`，默认最多约 5 行（按 40 列估算折行），点击整块展开。短思考没有折叠控件。
- Compaction / 中断是一行 `◇` 摘要；有 detail 时点击展开 Markdown。
- Worker 任务是圆角卡片，边框颜色跟 `running` / `completed` / `failed` / `cancelled` 走。默认只显示标题和状态摘要，点击后在卡片内复用 live block 渲染 trace；trace 使用最多 20 行的独立滚动区，默认跟随末尾，只挂载其视口附近的块。

实时 Turn 与历史 Turn 进入同一个 transcript 组件。用户消息、回合标题和内容块扁平化后按稳定 ID 挂载，工具沿用 tool call ID，数据更新不依赖新对象的引用相等。`turn_finished` 到来时，历史快照和 live 状态一起更新；视口内的工具不会因为转成历史而卸载重建，也不会重新排序到工具结果落盘的位置。

## 工具输出

每次调用保留自己的工具块。标题显示状态、工具名、关键参数、完成后的耗时和展开箭头；等待、执行中、成功、失败、取消与拒绝分别展示。关键参数由工具类型决定：`grep` 同时显示搜索词和范围，`read` 显示文件与指定范围，`bash` 显示实际命令。标题由 OpenTUI 按页面实际剩余宽度自然换行，不预先按固定列数切开命令或路径，窗口缩放时重新排版。Bash 命令最多预览三个屏幕行，其他工具标题最多一行；超出时在展开箭头旁标出省略，不用抽象描述替代命令。

结果在工具自身完成时补充，整个 Turn 结束时不再切换参数格式或折叠已展开的工具。默认的信息密度按工具区分：

| 工具 | 默认结果展示 |
| --- | --- |
| `read`、`list` | 实际读取范围或条目数，以及分页、截断提示；正文按需展开 |
| `grep` | 匹配数、文件数和少量命中位置；扫描上限与后续页单独提示 |
| `bash` | 退出码和最多五个屏幕行的输出；长输出取首尾，保留捕获上限与临时输出文件提示 |
| `edit`、`write` | 修改结果、增删行数与最多十个屏幕行的 diff 预览；diff 来自本次实际写入前后的内容 |
| 网页与历史读取 | 返回内容大小、检索覆盖或分页提示；正文按需展开 |
| 其他工具 | 通用短输出预览 |

失败原因直接显示，长诊断仍受预览高度限制。取消和权限拒绝不会显示成成功或普通执行失败。预览按终端列宽计算，`edit`、`write` 最多十个屏幕行，其余工具仍最多五行；中文、emoji 或单行长 JSON 不会绕过对应的行数上限。工具块继续使用无边框、无底色的缩进布局。Diff 只对整行文字着色，不使用行背景或行内背景高亮；新增行用柔和灰绿，删除行用柔和灰红，其余行保持辅助文字色。折叠预览和展开正文共用同一套渲染，长行换行后仍保留原行的增删颜色。

Diff 配色独立于成功／错误状态色。暗色主题的新增与删除分别使用 `#84AC95`／`#B78794`，亮色主题使用 `#4D755E`／`#996471`，比成功与错误提示更柔和。只对文字着色，沿用现有的 unified diff 文本和 hunk 标题，不额外引入背景高亮、语法高亮或行号。

点击工具标题或结果区域均可展开、折叠结果。所有工具展开时只增加已保存的结果内容，不显示完整参数 JSON，也不加 `Parameters`、`Result` 或 `Changes` 标题。`edit`、`write` 有 diff 时直接展开带颜色的修改内容，不重复展示输入的旧文本、新文本或写入正文，也不再附上重复的成功确认；失败或没有 diff 时保留工具返回的结果文本。选择结果文字不会触发展开切换，Worker 卡片内的工具使用相同组件。工具、思考、compaction 和 Worker 卡片的展开状态按块 ID 保存在当前视图中，滚出视口再返回或本次 Turn 转成历史时保留，不写入 Session Tree；离开会话或重启后使用默认折叠状态。

Diff 的整行颜色由同一个文本控件内的 styled chunks 表达，折行后仍保持颜色；展开长 diff 不会为每一行创建独立的原生文本缓冲区。

界面的折叠不改变模型上下文，也不恢复工具本身已经截断的内容。完整已保存结果、后续分页和 Bash 的捕获限制是不同概念，界面分别提示。文件 diff 的计算有大小和时间预算，超过预算时保留修改成功结果，并明确提示没有生成 diff。

工具执行器在 `tool_finished` 中提供 `content`、结构化 `details`、结束状态与执行耗时。相同信息随工具结果保存，历史投影与实时事件使用同一套 `TranscriptTool` 数据和格式化函数。没有记录的数据不从当前文件、时间差或文本猜测补齐。

委派类工具（`delegate_tasks` 等）不进入普通工具行，而是变成上面的任务卡片。

## 浮层

带有下级选项的命令，直接回车就打开输入框上方的选择面板，不要求先记住子命令或复制 ID。面板左右各留 1 列，圆角，`surface` 底，`borderStrong` 边；ask 使用 `spark` 边框，表示正在等待用户回答。

`/thread` 从命令注册表生成子命令列表。选择 status、history 后进入可滚动文档；选择 search 后将 `/thread search ` 填入输入框，等用户输入查询再执行。`/session`、`/thread sessions` 和不带 ID 的 `/thread open` 共用 Session 列表，显示当前 Session、请求摘要、ID 和创建时间。回车切换会话，工作区文件保持不变。

`/skill` 显示技能名称和描述。选择技能只把 `/skill <name> ` 填入输入框，用户可以追加指令，再按回车调用；浏览列表不会启动模型任务。

`/agent` 先列出 main、worker 和 dreamer。Main 直接进入模型列表；次级 Agent 提供 Off、On 和 Choose model。On 沿用已有模型，没有模型时才进入选择；Choose model 始终打开模型列表，选定后启用该 Agent。

模型面板支持直接输入 provider 或模型名称过滤，Backspace 删除过滤文字。列表末尾可切换 configured／all 范围；`/model list [provider]` 和各 Agent 的 model list 也复用这个面板。Esc 逐级返回，并保留上级的选中项。选择操作失败时留在原面板显示错误，允许重新选择或重试；成功切换模型、会话或完成 rewind 后关闭面板。

完整命令仍可直接输入。plain 模式读取命令结果的文本内容，不依赖选择面板。

共同语言：

- 标题 `accent` + bold，带一个功能图标（`⚙` `⎌` `ⓘ`）。
- 选中行 `surfaceHigh` 底、`sparkAlt` 字、`▸`。
- 当前已生效项用 `●` 和 `accent`，与光标选中分开。
- 模型和 rewind 的窗口最多 8 项；命令、Session 和 Skill 的窗口最多 6 项，每项两行，分别显示名称和说明。Ask 的选项由工具上限收在 4 个。
- 方向键只改 view 里的 selection signal，不经 controller `notify()`，避免整棵 session 树跟着闪。

## 状态与页脚

状态行在输入框上方。忙碌时左侧依次显示共享时钟的 braille spinner、活动文案和耗时；耗时紧跟在活动文案后面，仍属于左侧信息区，右侧只提示 `esc interrupt`。空间不足时先截断活动文案，优先保留计时。文案来自当前 activity（thinking / 工具名 / compacting / workers），结束后留下 `worked <duration>` 或 notice，notice 附带的独立耗时同样跟在文案后面。

模型重试时显示次数、退避等待时间和最近一次失败原因；下一次尝试开始后保留该原因，恢复输出后回到正常状态。原因去除终端转义序列、合并空白并限制为 240 个字符，状态行仍按可用宽度截断。

每个模型步骤先显示 `waiting for model`，收到思考或正文后分别显示 `thinking` 或 `responding`。工具参数仍在生成时显示 `generating <工具名> · <已接收 KiB> · step <步骤>`，同一帧只保留最新字节计数，避免长文件写入期间被误认为没有响应。该状态不代表工具已执行；完整调用生成后才进入原有的排队／执行状态。

页脚是一条 `surface` 底的单行，按终端宽度裁剪：

| 宽度 | 显示 |
| --- | --- |
| 任意 | `⊙` session id、模型名（不收缩） |
| ≥ 72 | 8 格 context meter + 百分比 |
| ≥ 96 | `⚡ cache`；若上次未命中，追加 `↓token` 和原因（`idle` / `model` / `prefix`） |
| 有 git | `⎇` 分支名 |
| 模型支持思考 | `· thinkingLevel`；宽屏再给 `⇧⇥` |

Session id 和分支名是页脚上仅有的两个可变宽标签，宽度按整列预先算好，不交给布局引擎按比例收缩。按比例收缩会得到小数列宽，文字节点取整时又向上取，两个相邻标签就会互相覆盖一列。空间不够时分支名先缩短（最少 6 列），然后 session id 缩短（最少 16 列）；仍然放不下时隐藏分支，只保留 session id。两者都用中间省略号截断；模型名前至少留两列空白。

Meter 用 `█▓▒░` 做 8 格含半格。颜色按用量：`< 60%` muted，`60–80%` warning，`≥ 80%` error。自动 compaction 触发点是 78%，所以正常使用里 meter 多半停在 muted 或 warning。Cache 尚未测到时写 `cache —`，不用 `0%`。

## 渲染约束

TUI 和 agent 执行解耦。所有展示事件经 `safeUiEvent` 进入 `UiEventBatcher`：约 33ms 一帧，相邻的 text/thinking delta（含 worker trace）会拼成一条。渲染失败不影响持久执行。

打开模型、Agent 等菜单只更新浮层，不重新读取会话或计算历史预览。会话切换、回退、回合结束和成功的手动压缩才刷新聊天记录；同一次输入的结束事件与返回结果合并成一次刷新。切换模型或 Agent 设置仍更新相关上下文统计，`/clear` 不会被命令收尾重新加载的历史覆盖。

工具预览依赖正文、显示宽度和预览规则，不因历史快照换了一批对象而重新折行。普通折叠预览取得足够的屏幕行后停止计算；Bash 保留原有的首尾预览规则。

工具块及其标题、结果区不参与纵向压缩，避免退出码、预览和展开提示被挤到同一行。标题的行数限制和绘制裁剪放在独立容器上；仅限制文本自身的 `maxHeight`，仍可能因布局压缩和取整多画一行。省略标记比较文本总行数与标题行数上限，不依赖文本节点被分配的高度。

动画共用一个 100ms 时钟。状态行耗时和所有 spinner 读同一个 signal，避免每个工具自己 `setInterval` 把 OpenTUI 顶到 max FPS。

Transcript 滚动区开启 `viewportCulling` 和 sticky-to-bottom，垂直滚动条隐藏。鼠标滚轮有单独的加速度曲线。`viewportCulling` 只裁剪绘制，不能限制已创建的原生对象，因此 `transcript-window.tsx` 另外按消息／工具块做虚拟列表：只挂载视口及上下各一屏的缓冲区，其余内容由两个高度占位块代替。不能按整回合保活，否则单个长回合仍会耗尽 OpenTUI 的句柄。

尚未挂载的块使用估算高度，挂载后缓存实际高度；终端宽度变化时重测。高度修正保留首个可见块和块内偏移，末尾阅读保持自动跟随；向上阅读时，新输出不把阅读位置拉回底部。鼠标和 PageUp／PageDown 的滚动在下一帧布局前处理，避免同时到来的流式更新覆盖滚动操作。虚拟列表不裁剪历史数据，也不改变模型上下文，只限制界面控件的生命周期。

## 代码位置

- `src/ui/terminal/theme.ts`：色板、syntax style、meter、图标、JSON 探测。
- `src/ui/terminal/session-screen.tsx`：主屏幕、页脚、浮层、输入框和附件行。
- `src/ui/terminal/composer-state.ts`：输入草稿、附件、粘贴进度，以及清空草稿后的异步结果隔离。
- `src/ui/terminal/clipboard.ts` / `composer-paste.ts`：本机剪贴板和贴图分流。
- `src/ui/terminal/widgets.tsx`：浮层共用的单行文字、选项行、标题和状态区。
- `src/ui/terminal/ask-input.ts`：当前提问的选项、自由回答和翻页。
- `src/ui/images.ts`：路径附件和附件 ID；图片限制、缩放和编码由 `src/core/images/prepare.ts` 共享。
- `src/ui/terminal/transcript.tsx`：欢迎页、回合分组、思考 / 工具 / 回复。
- `src/ui/terminal/transcript-window.tsx` / `transcript-expansion.ts`：历史与 Worker trace 的视口挂载、实测高度、滚动定位和展开状态。
- `src/ui/terminal/transcript-projection.ts`：session log → `TranscriptItem`，按原调用位置合并结果。
- `src/ui/terminal/tool-presentation.ts` / `tool-output.tsx`：工具参数、结果摘要、预览与展开。
- `src/ui/terminal/view.tsx`：挂载、键盘、overlay selection。
- `src/ui/terminal/spinner.tsx`：共享动画时钟。
- `src/ui/events.ts` / `src/ui/state.ts`：展示事件、live 状态、`tool_finished.content`。
- `src/ui/reducer.ts` / `src/ui/transcript-stream.ts`：状态更新；主 agent 与 Worker 共用文字和工具调用的流式更新规则。
- `src/core/agent/tool-call-executor.ts`：生成工具执行事件，由 UI 订阅展示。
