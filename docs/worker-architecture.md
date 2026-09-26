# Thread 的 Worker 架构

Thread 的 worker 在主回合内临时运行，按主 agent 的委派承担实现、调查、搜索或审查任务，无需预设不同角色。它不是另一棵 Session Tree，也不拥有私有工作区。主 agent 和 worker 直接共享当前项目目录，依靠清楚的任务边界协调并发。

## 设计目标

主 agent 每次可将一至三个边界明确的任务交给 worker，默认最多同时运行六个 worker。为了节省时间而委派时，应先确定自己或其他 worker 能同时推进什么，并计入交代任务和审查结果的成本。小查询、小改动和能快速解决的当前阻塞事项通常自己处理，紧密耦合的工作也留在主线程。另一种用途是隔离大量调查信息：worker 阅读和搜索后返回结论，这时即使需要等待，也可能值得委派。

主 agent 仍负责总体设计、结果检查和用户沟通。实现任务要先确定所依赖的共享接口，再把任务内部的调查和实现选择留给 worker。调查任务则只需明确问题、范围和需要的证据，不要求主 agent 先完成调查或确定公共接口。

它刻意不提供隔离目录、ChangeSet、机械 review 门禁或 apply/rebase 流程。Worker 写入后，修改已经存在于当前项目中。主 agent 根据任务需要使用现有的读文件、搜索、diff 等工具审查结果，不必重新做完整调查。

```text
用户
  │
  ▼
主 agent ── delegate_tasks ──┬── worker A ──┐
  │                         └── worker B ──┤
  │                                        │
  └──────── 检查修改与调查结论 ◀───────────┘
```

## 主 agent 的四个任务工具

CLI/TUI 使用 `/agent worker model <provider>/<model>` 选择模型并启用，`/agent worker on|off` 切换开关；配置文件使用 `agents.worker`。`agents.worker.maxConcurrent` 控制总并发数，默认 6；单次委派最多 3 个任务。嵌入配置见 [runtime 指南](./runtime.md)。

Worker 开启后，Thread 只注册四个任务工具：

| 工具 | 用途 |
| --- | --- |
| `delegate_tasks` | 每次启动一至三个任务，受总并发上限约束；需要写入的任务之间不得有重叠的 `writeScope` |
| `wait_tasks` | 等待第一个或全部任务结束，或达到 `timeoutMs`（默认 60000 毫秒）；返回 `{ tasks, timedOut }`，包含状态、用量和最终回复。等待超时不取消 worker，再次等待时只传仍在运行的任务 ID |
| `request_revision` | 给已完成任务追加具体反馈，在同一目录和同一 worker 上下文继续任务；保留原任务的 `tools` 和 `writeScope` |
| `cancel_task` | 中断运行中的任务；已经写入的文件不会回滚 |

不需要 `inspect_task`：任务摘要和 trace 保留在 Agent Task 历史中，而代码检查直接针对当前文件进行。不需要 `apply_task` 或 `rebase_task`：worker 的修改没有候选态，也没有待合入的分支。

## 按任务选择工具

Worker 的执行根是共享项目目录，但并不会自动获得所有工具。主 agent 在委派时说明目标、已知背景、当前约束、验收标准和期望返回的内容，并用必填的 `tools` 列表选择完成任务所需的工具。无需工具的任务可以传 `[]`；未知或重复名称会被拒绝。

可选工具是现有的九个基础内置工具：`read`、`view_image`、`list`、`grep`、`write`、`edit`、`bash`、`websearch`、`webfetch`。这里不包含主 agent 的 `ask`、`skill`、会话和委派工具，也不包含宿主自定义工具。`view_image` 需要 worker 模型支持图片；网页工具沿用已有实现、宿主 `toolPolicy` 和取消处理。

例如，可以按下面的方式交代任务，不必先创建不同的 worker 角色：

| 任务 | 工具选择 | 写入范围与返回内容 |
| --- | --- | --- |
| 追踪一条代码调用路径 | `list`、`grep`、`read` | `writeScope: []`；返回结论、关键文件和符号、未解决的问题 |
| 查阅官方资料 | `websearch`、`webfetch` | `writeScope: []`；返回结论及来源 URL |
| 修改一个独立模块 | `list`、`grep`、`read`、`edit`、`write` | 声明需要修改的文件或目录；返回修改内容、文件和未完成事项 |

调查的验收标准还应说明什么证据足以回答问题。Worker 得到足够证据、满足验收标准后结束，不因发现相邻话题就扩大调查；返回时区分已确认的发现、推断和未解决的问题。缺少信息、工具或遇到其他任务尚未完成的依赖时，应报告具体阻塞。

Worker profile 保存候选工具，每次执行只把任务选中的工具注册到独立的 `ToolRegistry`。这份注册表同时决定模型能看到哪些工具，以及执行器允许调用哪些工具；未分配的工具不会执行，也不会回退到全部候选工具。后续修订沿用原任务的选择。

## 共享工作区与 writeScope

每项任务须声明 `writeScope`，没有文件改动的任务传 `[]`；分配 `write` 或 `edit` 时则必须提供非空范围。调查任务通常只需要读取或搜索工具，不应授予文件写入工具；只有确实需要执行命令时才授予 `bash`。

`writeScope` 用于协调写入任务，且**只在内置文件写入入口强制检查**：

- 同一次 `delegate_tasks` 的写入范围不能重叠；新任务或返工不能与运行中任务的写入范围重叠。纯调查没有范围冲突，但不能依赖其他 worker 尚未稳定的文件。
- 内置 `write`、`edit` 在共享文件写入入口检查实际目标路径。文件范围只允许该文件，目录范围允许其后代；范围外调用在备份、创建目录和修改文件前返回工具错误。符号链接不能扩大声明范围。
- 返工保留原任务的工具选择和范围。宿主工具策略即使允许调用，也不会跳过内置写入范围检查。
- 主 agent 的提示要求它在 worker 运行时不要修改对应范围。Worker 须保留他人的修改；无写入任务不得修改文件。完成改动后报告修改内容和文件，完成调查、搜索或审查后报告结论、证据和未解决问题；仅报告实际做过的验证。

`writeScope` 不是文件系统沙箱；`bash` 不只读，Thread 不解析或限制其命令会写入哪些路径，空范围也不能保证 bash 不写文件。仅在任务确实需要 shell 时授予并协调可能的副作用；宿主策略仍适用。任务边界不清楚、修改高度耦合，或必须同时改共享核心文件的工作，不适合并行委派。

主 agent 和 worker 复用文件服务的同路径写入队列，获得执行机会后会重新检查目标；关闭文件 checkpoint 仍保留协调和范围检查。Worker 用 `write` 覆盖已有文件时，还必须有自己模型上下文中的读取版本凭据，不能把主 agent 的读取或委派文字当作凭据；版本变化时须重新读取。自身成功写入会更新凭据，`edit` 保持精确替换规则，详见 [覆盖前的文件版本检查](./runtime.md#覆盖前的文件版本检查)。

## 共享项目指令

coding 应用启动时加载项目根目录的 `AGENTS.md`，与宿主传入的 `sharedInstructions` 一起提供给主 agent 和 worker。worker 保留独立的角色提示词，任务目标和范围仍来自委派参数。运行期间修改指令文件不会改变已打开实例的快照，包括后来启用的 worker；重新打开应用才重新读取。

裸 `ThreadRuntime.open()` 不扫描项目指令文件，宿主可通过 `sharedInstructions` 显式提供。coding 应用可用 `projectInstructions: false` 关闭自动读取。根目录之外的分层指令加载尚未实现，读取边界及文件大小限制见 [runtime 指南](./runtime.md)。

通用 worker 提示词保留职责、任务边界和结果报告要求。每项任务的写入范围、共享工作目录和运行平台也放在系统提示词中，作为执行约束。

主 agent 发出的初始 user 消息只包含任务标题、目标、指导和验收标准。它不重复列出工具名称，也不展示完整委派参数。模型可见的工具定义和实际可调用工具，仍由该任务选定的 `tools` 注册表决定。

任务开始时，只有工具列表包含 `write`、`edit` 或 `bash`，才追加文件操作与 checkpoint 说明；仅有读取、网页工具或没有工具的任务不接收这段说明。Checkpoint 描述取自实际文件历史服务的配置，不影响共享项目指令的注入或工具权限。

## 生命周期

任务只有四种状态：

```text
running ──成功──▶ completed
   ├──错误──────▶ failed
   └──中断──────▶ cancelled

completed ──request_revision──▶ running
```

`request_revision` 只接受 `completed` 任务。主 agent 的返工反馈原文（去除首尾空白）作为后续 user 消息追加到原来的 Agent Task journal，不另加反馈前缀，也不重新发送初始任务；worker 因而能继续利用此前对话和工具结果，且保留原任务的工具与范围；revision 随新运行递增。

任务属于创建它的主回合。主回合结束或应用关闭时，先向所有所属运行中任务发出取消信号，再等待它们全部收尾；结束后移除临时运行对象，保留任务历史。重启时发现 v3 历史中仍有 `running` 任务，也会把它标记为 `cancelled`。Thread 不让 worker 跨回合存活，也不提供后台 mailbox。

Worker 失败、达到运行时限或被取消时，不恢复文件；`wait_tasks` 的等待时限只结束本次等待。主 agent 必须检查共享目录中的部分修改；需要撤销内置 `edit`、`write` 修改时使用 `/rewind`；bash 修改不被跟踪。

Worker 默认最多 100 个模型步骤、60 分钟。上下文溢出时以 `Worker context exhausted` 明确失败，提示主 agent 拆分任务或缩小读取范围，不自动压缩或重试同一任务。主 agent、Worker 和 Dreamer 共用模型结果校验：返回工具调用但 stop reason 不是 `toolUse` 时结束执行，未放行的工具不会启动。流式阶段已经完成的读取结果仍保留。

主 agent 的 `runtime.on()` 扩展钩子不作用于 Worker；宿主 `toolPolicy` 和 runtime 状态路径保护覆盖 Worker，`writeScope` 不能授权修改受保护状态。

## 执行与记录

主 agent 和 worker 共用 `AgentStepRunner`，但使用不同 journal：

- 主 agent 通过 `SessionTurnJournal` 写入 Session Tree。
- Worker 通过 `AgentTaskJournal` 写入独立的 Agent Task trace。

这样可以复用同一套“模型回复—工具执行—结果回传”循环，同时不把 worker 的完整轨迹塞进主 agent 上下文。TUI 在原始委派位置显示精简任务卡片，状态只可能是 `running`、`completed`、`failed` 或 `cancelled`。

初始任务和返工反馈分别保存为 trace 的 user 消息。返工只追加一次真实 user 消息，不另存 `reviewFeedback` 字段或 `revision_requested` 事件；该消息保存后才将任务标记为运行中并启动新一轮。每轮 `agent_run_started` 使用该轮实际输入的正文和持久 `entryId`，让界面按同一条记录展示实时输入与历史对话。卡片完成摘要只取最后一条 user 消息之后的 assistant 文本；当前修订没有文本时显示 `completed`，此前回复仍保留在详情中。Dreamer 没有持久 user entry，因此事件类型中的 `entryId` 是可选字段。

Agent Task 历史使用独立的 `thread-agent-task-v3`（`formatVersion: 3`）JSONL 事件流：

```text
agent-tasks/
  events.jsonl
```

旧 v1/v2 记录、ChangeSet 清单和私有工作区数据不会迁移或读取。若现有 `events.jsonl` 不是 v3 格式或出现未知事件，启动会明确失败，不会默默忽略旧记录，也不会把旧语义误解成共享工作区任务。

Worker 和主 agent 共用文件历史入口。开启文件 checkpoint 时，内置 `edit`、`write` 写入前的记录保存在父 turn 的 Session Tree 中，每个 turn 对同一路径只保存首次编辑前的状态；worker 的 bash 改动不被跟踪。返工、失败和取消均保留已保存的编辑记录。

## 一次典型流程

1. 主 agent 判断委派的收益，明确任务边界；实现任务先确定必要的共享接口，调查任务明确问题和证据要求。用 `guidance` 传递相关背景、已知位置或来源、已有发现、本轮用户约束和预期结果，并为每项任务选择 `tools` 与 `writeScope`。Worker 不继承主对话。
2. Worker 在共享项目目录中工作；若修改文件，结果立即可见。主 agent 可继续处理独立工作，不重复已委派任务。
3. 后续决策依赖结果，或已经没有有价值的独立工作时，主 agent 调用 `wait_tasks`。
4. Worker 完成后，主 agent 检查修改、影响后续决策的关键证据和未完成项，不必重新做完整调查。运行状态为 `completed` 不代表验收条件自动通过。
5. 有具体问题时调用 `request_revision`；没有问题则继续后续任务。
6. 主回合结束前等待或取消仍在运行的任务。

## 代码位置

- `src/core/agent-task/tools.ts`：四个主 agent 任务工具。
- `src/core/agent-task/orchestrator.ts`：范围校验、并发、等待、返工、取消和回合归属。
- `src/core/agent-task/profile.ts`、`task-runner.ts`：注册候选工具，按任务选择工具后以项目根目录运行 worker。
- `src/core/agent-task/model.ts` 与 `repository.ts`：v3 状态、事件和持久化。
- `src/core/agent/step-runner.ts`：主 agent 与 worker 复用的单步执行核心。
- `src/core/file-history/`：主 agent 和 worker 共用的内置编辑备份、恢复、校验和 GC。
- `src/ui/`：精简的任务卡片和 trace 展示。
