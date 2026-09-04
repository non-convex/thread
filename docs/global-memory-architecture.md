# Thread 全局记忆与 Dreamer 架构

## 目标

Thread 使用一个轻量的跨项目记忆文件保存长期稳定且与单一项目无关的信息。Main 负责用户明确表达的稳定信息；Dreamer 则从长期互动和 Agent 工作轨迹中发现未被直接说明、但有充分证据支持的用户模式与可迁移经验。实现不引入数据库、记忆版本、审批流、结构化记忆模型、专用记忆工具或跨进程锁。

唯一持久状态是：

```text
${THREAD_HOME}/.THREAD.md
```

文件最多保留 15 条带时间戳的 Markdown 列表项。文件不存在等价于空记忆。

## Agent Profile 与生命周期

`src/agent/profile.ts` 定义所有 Agent 共用的最小 `AgentProfile`：

- `id`
- `model`
- `thinkingLevel`
- `systemPrompt`
- `tools`

内置 Profile 是 `main`、`implementation-worker` 和 `dreamer`。Registry 只负责 Profile 的发现、替换与诊断，不承载具体 Agent 的生命周期策略：

- Main 由前台 turn runtime 管理；
- implementation-worker 由任务协调器管理并发、revision、step 与超时限制；
- Dreamer 由独立调度器管理待审阅批次、取消、重试和空闲触发。

这种边界让新 Agent 只复用模型执行所需的公共字段，同时避免把不同生命周期塞进一个通用基类。

模型与启停设置统一从 `/agent` 进入：

```text
/agent
/agent <id>
/agent <id> model [all]
/agent <id> model list [provider]
/agent <id> model <provider>/<model>
/agent implementation-worker|dreamer on|off
```

为次级 Agent 选择模型时会同时启用它。两个次级 Agent 都默认关闭，且没有隐式模型回退。

## Session 快照

Thread 启动时读取一次 `.THREAD.md`，并把内容绑定到当时所有已存在的 Session。之后遵循以下规则：

- 当前 Session 运行期间始终使用其固定快照；
- `/new` 先重新读取磁盘，再把结果只绑定到新 Session；
- Session 切换恢复目标 Session 已有的快照；
- 进程重启会为所有 Session 统一读取新快照；
- 非 `ENOENT` 读取错误产生非致命诊断，并继续使用最近一次成功读取的内容。

快照位于模型请求的 system prompt 末尾，因此整体顺序是：

```text
System Prompt → Global Memory → Live Context
```

它计入请求上下文预算，但不写入 Session Tree，也不参与搜索、rewind 或 compaction。

## 写入边界

Main 与 Dreamer 继续使用普通 `read`、`write`、`edit`。文件执行上下文允许它们额外写入 `.THREAD.md` 这一精确绝对路径，而不是整个 `THREAD_HOME`。外部目录、相邻文件、目录后代和符号链接仍被拒绝。

Implementation worker 没有此外部写入例外，只能遵循原有项目工作区边界。

Main 只有在用户当前消息明确给出稳定、跨项目的信息时才维护记忆；写入前必须重新读取磁盘。项目决策、临时要求、工具输出中的信息和 Agent 推断都不能由 Main 写入全局记忆。

Dreamer 不重复提取这类明确指令。它可以把用户与 Agent 的互动、用户纠正，以及 Agent 的 reasoning、工具调用和工具结果作为观察材料，从中推断隐含的长期模式和可迁移经验。单次事件只有在结果明确、经验清晰且确实适用于无关项目时才值得记录；普通的工程常识、模型自述、未经结果验证的计划和猜测均不足以成为记忆。

## Dreamer 调度

Dreamer 默认使用 `high` thinking，不限制 model step，单次最多运行 5 分钟，同时最多一个实例。它只有 `read`、`write`、`edit` 三个工具，并使用进程内临时 journal；运行轨迹不会成为 Agent Task 或 Session Tree 历史。

每个结束的前台 turn 会作为一个独立单元加入待审阅队列。累计 10 个结束 turn 后，调度器从 Main 进入空闲状态的时刻开始计时；只有 Main 连续空闲 10 分钟才会启动 Dreamer。Compaction 不再单独触发 Dreamer，也不会把被压缩消息重复加入待审阅队列。

启动时只估算由待处理 turn 生成的审阅消息：如果不超过 Dreamer 模型上下文窗口的 50%，就作为一个批次审阅；如果超过，则按完整 turn 贪心拆成多个批次，每批最多占 50%。单个 turn 本身超限时，对它的格式化内容做保留首尾的截断。一次启动产生的所有批次共享同一个 5 分钟总时限和待处理快照；运行期间新加入的 turn 留给下一轮。

新用户输入会取消尚未到期的空闲计时，但不会中止已经运行的 Dreamer；两者可以并行。每个批次成功后只移除该批覆盖的完整 turn；当前批次失败或总时限到期时，当前批次和后续批次仍保留，并设置独立的重试延迟。关闭或禁用 Dreamer 才会取消运行并清除待审阅内容。

## 审阅材料与稀疏原则

Dreamer 接收用户文本、Assistant 对用户可见的文本、reasoning、工具调用、工具结果，以及 `ask` 工具记录的用户答案。为了避免单次大型内容占满上下文，单段 reasoning、工具参数和工具结果各自最多保留 1,000 个字符；截断时同时保留开头与结尾。

这些内容只是观察材料，不自动构成记忆事实。Dreamer 优先寻找多次互动共同支持的模式；Assistant 的说法、计划和自我评价不能单独证明某项经验。记忆必须同时满足证据充分、长期稳定、可跨项目复用和未来确有价值，且不能包含秘密或敏感信息。Dreamer 可以清理明显违反这些标准的旧条目，但不能仅因本批次没有再次出现某项信息就删除它。没有高价值变化是大多数审阅的预期结果，此时 Dreamer 不修改文件并保持静默；最近错误可从 `/agent` 状态查看。
