# Thread 的 Subagent 架构

Thread 的 subagent 是主回合内临时运行的实现 worker。它不是另一棵 Session Tree，也不拥有私有工作区。主 agent 和 worker 直接共享当前项目目录，依靠清楚的任务边界协调并发。

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

Subagent 开启后，Thread 只注册四个任务工具：

| 工具 | 用途 |
| --- | --- |
| `delegate_tasks` | 启动一至两个写入范围互不重叠的任务 |
| `wait_tasks` | 等待第一个或全部任务结束，返回状态、用量和 worker 最终回复 |
| `request_revision` | 给已完成任务追加具体反馈，在同一目录和同一 worker 上下文继续修改 |
| `cancel_task` | 中断运行中的任务；已经写入的文件不会回滚 |

不需要 `inspect_task`：任务摘要和 trace 保留在 Agent Task 历史中，而代码检查直接针对当前文件进行。不需要 `apply_task` 或 `rebase_task`：worker 的修改没有候选态，也没有待合入的分支。

## 共享工作区与 writeScope

Worker 的 `ToolCallExecutor` 以项目根目录为执行根，因此 `read`、`write`、`edit` 和 `bash` 看到的就是主 agent 当前看到的目录。

每项任务仍必须声明 `writeScope`。它是任务协调约束，不是文件系统沙箱：

- 同一次 `delegate_tasks` 中的任务不能重叠。
- 新任务或返工不能与任何运行中任务重叠。
- 主 agent 的提示要求它在 worker 运行时不要修改对应范围。
- Worker 的提示要求它遵守范围、保留他人修改，并在最终回复列出修改文件和验证结果。

Thread 不增加跨 runner 文件锁，也不尝试分析任意 bash 命令实际会写哪些路径。任务边界不清楚、修改高度耦合，或必须同时改共享核心文件的工作，不适合并行委派。

## 生命周期

任务只有四种状态：

```text
running ──成功──▶ completed
   ├──错误──────▶ failed
   └──中断──────▶ cancelled

completed ──request_revision──▶ running
```

`request_revision` 只接受 `completed` 任务。反馈追加到原来的 Agent Task journal，worker 因而能继续利用此前对话和工具结果；revision 随新运行递增。

任务属于创建它的主回合。主回合结束前，运行中的任务必须被等待或取消。关闭应用或重启时发现 v2 历史中仍有 `running` 任务，也会把它标记为 `cancelled`。Thread 不让 worker 跨回合存活，也不提供后台 mailbox。

失败、超时和取消都只停止 worker，不恢复文件。主 agent 必须检查共享目录中的部分修改；需要整体恢复时使用现有 `/rewind`。

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

Workspace State 不再参与 subagent 合入，只继续服务于主回合 checkpoint、`/rewind` 恢复、完整性校验和垃圾回收。

## 一次典型流程

1. 主 agent 先确定公共接口和总体方案，再把互不重叠的叶子任务交给 `delegate_tasks`。
2. Worker 直接在项目目录中运行，修改会立即可见；主 agent 可继续处理范围外的工作。
3. 后续决策依赖结果时，主 agent 调用 `wait_tasks`。
4. Worker 完成后，主 agent 用普通文件工具和测试命令检查当前项目。
5. 有具体问题时调用 `request_revision`；没有问题则继续后续任务，无需 apply。
6. 主回合结束前等待或取消仍在运行的任务。

## 代码位置

- `src/agent-task/tools.ts`：四个主 agent 任务工具。
- `src/agent-task/orchestrator.ts`：范围校验、并发、等待、返工、取消和回合归属。
- `src/agent-task/task-runner.ts`：以项目根目录运行一个 worker。
- `src/agent-task/model.ts` 与 `repository.ts`：v2 状态、事件和持久化。
- `src/agent/step-runner.ts`：主 agent 与 worker 复用的单步执行核心。
- `src/workspace-state/`：与 subagent 解耦后的 checkpoint、恢复、校验和 GC。
- `src/ui/`：精简的任务卡片和 trace 展示。
