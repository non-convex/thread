# Thread 全局记忆与 Dreamer 架构

## 目标

Thread 使用一个轻量的跨项目记忆文件保存用户明确表达、长期稳定且与单一项目无关的信息。实现不引入数据库、记忆版本、审批流、结构化记忆模型、专用记忆工具或跨进程锁。

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

Main 只有在用户当前消息明确给出稳定、跨项目的信息时才维护记忆；写入前必须重新读取磁盘。项目决策、临时要求、工具输出中的信息和 Agent 推断都不是记忆证据。

## Dreamer 调度

Dreamer 默认使用 `low` thinking，最多执行 8 个 model steps，单次最多运行 2 分钟，同时最多一个实例。它只有 `read`、`write`、`edit` 三个工具，并使用进程内临时 journal；运行轨迹不会成为 Agent Task 或 Session Tree 历史。

每个结束的前台 turn 会加入待审阅批次。调度器在以下任一条件满足时运行：

- 成功 compaction 后，前台操作一结束就尽快运行，并附带被压缩的原始消息；
- 累计 10 个结束 turn 后，连续空闲 10 分钟。

新用户输入会取消正在运行的 Dreamer，并等待它安全停止。未完成批次仍保留，前台操作结束后重新调度。成功运行只移除已经覆盖的批次；失败保留批次、记录最近错误，并等待下一次空闲或 compaction 触发。关闭 Dreamer 会取消运行、清除计时器及待审阅内容。

## 证据过滤

Dreamer 只接收：

- 用户文本；
- Assistant 对用户可见的文本，且只能作为上下文；
- `ask` 工具记录的用户答案。

Thinking、普通工具输出和工具调用参数不会进入 Dreamer 输入。Assistant 文本本身不能成为新增记忆的唯一依据。没有高价值变化时，Dreamer 不修改文件并保持静默；最近错误可从 `/agent` 状态查看。
