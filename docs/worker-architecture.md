# Thread 的 Worker 架构

Thread 的 worker 在主回合内临时运行，负责主 agent 委派的实现任务。它不是另一棵 Session Tree，也不拥有私有工作区。主 agent 和 worker 直接共享当前项目目录，依靠清楚的任务边界协调并发。

## 设计目标

这套实现只解决一件事：让主 agent 可以把一至两个边界明确的叶子任务并行交给 worker，同时仍然负责总体设计、检查和用户沟通。

它刻意不提供隔离目录、ChangeSet、机械 review 门禁或 apply/rebase 流程。Worker 写入后，修改已经存在于当前项目中。主 agent 直接使用现有的读文件、搜索、diff、bash 和测试工具审查结果。

```text
用户
  │
  ▼
主 agent ── delegate_tasks ──┬── worker A ──┐
  │                         └── worker B ──┤
  │                                        │
  └──────── 直接审查共享项目目录 ◀─────────┘
```

## 主 agent 的四个任务工具

CLI/TUI 使用 `/agent worker model <provider>/<model>` 选择模型并启用，`/agent worker on|off` 切换开关；配置文件使用 `agents.worker`。嵌入配置见 [runtime 指南](./runtime.md)。

Worker 开启后，Thread 只注册四个任务工具：

| 工具 | 用途 |
| --- | --- |
| `delegate_tasks` | 启动一至两个写入范围互不重叠的任务 |
| `wait_tasks` | 等待第一个或全部任务结束，或达到 `timeoutMs`（默认 60000 毫秒）；返回 `{ tasks, timedOut }`，包含状态、用量和最终回复。等待超时不取消 worker，再次等待时只传仍在运行的任务 ID |
| `request_revision` | 给已完成任务追加具体反馈，在同一目录和同一 worker 上下文继续修改 |
| `cancel_task` | 中断运行中的任务；已经写入的文件不会回滚 |

不需要 `inspect_task`：任务摘要和 trace 保留在 Agent Task 历史中，而代码检查直接针对当前文件进行。不需要 `apply_task` 或 `rebase_task`：worker 的修改没有候选态，也没有待合入的分支。

## 共享工作区与 writeScope

Worker 的 `ToolCallExecutor` 以项目根目录为执行根，因此 `read`、`write`、`edit` 和 `bash` 看到的就是主 agent 当前看到的目录。

每项任务必须声明 `writeScope`，用于任务协调和内置文件工具的写入检查：

- 同一次 `delegate_tasks` 中的任务不能重叠。
- 新任务或返工不能与任何运行中任务重叠。
- 内置 `write`、`edit` 在共享文件写入入口检查实际目标路径。文件范围只允许该文件，目录范围允许其后代；范围外调用在备份、创建目录和修改文件前返回工具错误。符号链接不能扩大声明范围。
- 返工保留原任务范围。宿主工具策略即使允许调用，也不会跳过范围检查。
- 主 agent 的提示要求它在 worker 运行时不要修改对应范围。
- Worker 的提示要求它遵守范围、保留他人修改，并简短报告已完成工作、修改文件和未完成项；实际做过验证时再附结果。

主 agent 和 worker 复用文件服务的同路径写入队列，获得执行机会后会重新检查目标；关闭文件 checkpoint 仍保留协调和范围检查。`writeScope` 不是文件系统沙箱，Thread 不分析或限制任意 bash 命令、自定义工具实际会写哪些路径。任务边界不清楚、修改高度耦合，或必须同时改共享核心文件的工作，不适合并行委派。

## 共享项目指令

coding 应用启动时加载项目根目录的 `AGENTS.md`，与宿主传入的 `sharedInstructions` 一起提供给主 agent 和 worker。worker 保留独立的角色提示词，任务目标和范围仍来自委派参数。运行期间修改指令文件不会改变已打开实例的快照，包括后来启用的 worker；重新打开应用才重新读取。

裸 `ThreadRuntime.open()` 不扫描项目指令文件，宿主可通过 `sharedInstructions` 显式提供。coding 应用可用 `projectInstructions: false` 关闭自动读取。根目录之外的分层指令加载尚未实现，读取边界及文件大小限制见 [runtime 指南](./runtime.md)。

## 生命周期

任务只有四种状态：

```text
running ──成功──▶ completed
   ├──错误──────▶ failed
   └──中断──────▶ cancelled

completed ──request_revision──▶ running
```

`request_revision` 只接受 `completed` 任务。反馈追加到原来的 Agent Task journal，worker 因而能继续利用此前对话和工具结果；revision 随新运行递增。

任务属于创建它的主回合。主回合结束或应用关闭时，先向所有所属运行中任务发出取消信号，再等待它们全部收尾；结束后移除临时运行对象，保留任务历史。重启时发现 v2 历史中仍有 `running` 任务，也会把它标记为 `cancelled`。Thread 不让 worker 跨回合存活，也不提供后台 mailbox。

Worker 失败、达到运行时限或被取消时，不恢复文件；`wait_tasks` 的等待时限只结束本次等待。主 agent 必须检查共享目录中的部分修改；需要撤销内置 `edit`、`write` 修改时使用 `/rewind`；bash 修改不被跟踪。

## 执行与记录

主 agent 和 worker 共用 `AgentStepRunner`，但使用不同 journal：

- 主 agent 通过 `SessionTurnJournal` 写入 Session Tree。
- Worker 通过 `AgentTaskJournal` 写入独立的 Agent Task trace。

这样可以复用同一套“模型回复—工具执行—结果回传”循环，同时不把 worker 的完整轨迹塞进主 agent 上下文。TUI 在原始委派位置显示精简任务卡片，状态只可能是 `running`、`completed`、`failed` 或 `cancelled`。

Agent Task 历史使用独立的 `thread-agent-task-v2` JSONL 事件流：

```text
agent-tasks/
  events.jsonl
```

旧 v1 记录、ChangeSet 清单和私有工作区数据不会迁移或读取。若现有 `events.jsonl` 不是 v2 格式，启动会快速失败，避免把旧语义误解成共享工作区任务。

Worker 和主 agent 共用文件历史入口。开启文件 checkpoint 时，内置 `edit`、`write` 写入前的记录保存在父 turn 的 Session Tree 中，每个 turn 对同一路径只保存首次编辑前的状态；worker 的 bash 改动不被跟踪。返工、失败和取消均保留已保存的编辑记录。

## 一次典型流程

1. 主 agent 先确定公共接口和总体方案，再把互不重叠的叶子任务交给 `delegate_tasks`；用现有 `guidance` 传递已知文件位置、接口和设计决定、本轮用户约束及剩余工作，worker 不继承主对话。
2. Worker 直接在项目目录中运行，修改会立即可见；主 agent 可继续处理范围外的工作。
3. 后续决策依赖结果时，主 agent 调用 `wait_tasks`。
4. Worker 完成后，主 agent 检查当前文件和未完成项；运行状态为 `completed` 不代表验收条件自动通过。
5. 有具体问题时调用 `request_revision`；没有问题则继续后续任务，无需 apply。
6. 主回合结束前等待或取消仍在运行的任务。

## 代码位置

- `src/core/agent-task/tools.ts`：四个主 agent 任务工具。
- `src/core/agent-task/orchestrator.ts`：范围校验、并发、等待、返工、取消和回合归属。
- `src/core/agent-task/task-runner.ts`：以项目根目录运行一个 worker。
- `src/core/agent-task/model.ts` 与 `repository.ts`：v2 状态、事件和持久化。
- `src/core/agent/step-runner.ts`：主 agent 与 worker 复用的单步执行核心。
- `src/core/file-history/`：主 agent 和 worker 共用的内置编辑备份、恢复、校验和 GC。
- `src/ui/`：精简的任务卡片和 trace 展示。
