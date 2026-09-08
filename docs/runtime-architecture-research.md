# Thread runtime 架构调研与最小演进建议

调研日期：2026-09-07。Thread 代码基线：`053ed76`。本文承接本轮会话中对 thread、codex、opencode、pi 本地代码的审查，补充官方文档、协议及作者文章的网络调研。下文保留调研依据、历史问题和设计草图，配置边界已按后续实现更新。

实现更新（2026-09-08）：统一入口为 `ThreadRuntime.open()`，支持按名称选择基础工具并混用自定义工具、显式 Skill 加载路径和宿主系统提示词。文件 checkpoint 默认关闭，会话仍然落盘，可只回退会话；CLI 与 ThreadApp 共享应用默认体验，不再提供 coding runtime 创建函数。生命周期修复、宿主策略、领域事件和执行预算继续保留。应用通过组合持有 runtime，执行器按轮创建，运行中改变思考偏好从下一轮生效。实际 API 和运行方法见 [runtime 使用指南](./runtime.md)，接口细节以该指南及类型声明为准。

MCP 定位为未来核心能力，将复用同一工具注册、策略、执行和取消机制；当前没有 MCP 客户端或占位配置。跨会话并发、服务化和内存会话存储仍然暂缓。

Codex 设计复查后的落实项：worker 的 `writeScope` 在现有内置文件写入入口强制检查；coding 应用启动时读取根目录 `AGENTS.md`，通过 `sharedInstructions` 共享给主 agent 和 worker；仓库增加精简指引，CI 执行独立宿主和依赖方向验证。继续复用现有执行器和文件服务，没有增加沙箱框架、分层指令扫描或新的协议层。

结论：保留现有执行循环、Session Tree、工具调度和文件回退，把它们整理成一个可以直接调用的库。先解决资源所有权、公共入口、宿主配置和事件身份；服务化、跨会话并发、持久化重放及远程环境按实际接入需求推进。

这里的“可嵌入”首先指运行在兼容宿主进程中的库。Web UI 可以连接后端 runtime；它不要求 agent 内核直接运行在浏览器中。首版可以继续保留已声明的 Bun 运行要求和本地项目目录，另一个执行平台出现时再扩大兼容范围。

## 1. 调研依据与适用范围

下表的“观察”来自来源；“对 thread 的判断”是结合当前代码作出的建议，不是来源对本项目的评价。

| 来源 | 核实的观察 | 对 thread 的判断 |
| --- | --- | --- |
| [pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) | 用工厂创建 AgentSession，支持 prompt、订阅、工具选择、内存会话和资源加载配置；SDK 可以包含在主包中 | 优先参考其直接嵌入方式；分清入口比拆成许多 npm 包更重要 |
| [OpenAI Agents SDK：运行](https://openai.github.io/openai-agents-js/guides/running-agents/) | agent 定义与 runner 分离；运行可传 context、session、signal 和 maxTurns | 把依赖及预算显式传入，不需要为普通工具循环建立图引擎 |
| [OpenAI Agents SDK：会话](https://openai.github.io/openai-agents-js/guides/sessions/) | 会话是可替换的持久化能力；有内存实现，也能接入其他后端 | 存储替换是有效扩展点，但不能把其简单消息接口原样套到 thread 的树、回退和执行事实模型上 |
| [OpenAI Agents SDK：流式输出](https://openai.github.io/openai-agents-js/guides/streaming/) | 流结束或取消后仍需等待 completed；它包括剩余回调和持久化等收尾 | 明确完成屏障，不能让 UI 退出代替执行结算 |
| [Codex App Server](https://developers.openai.com/codex/app-server/) | 面向丰富客户端提供 Thread、Turn、Item 操作、流式通知及双向请求 | 借鉴对象身份和操作语义；完整 app-server 是另一个交付阶段 |
| [OpenCode SDK](https://opencode.ai/docs/sdk/) | 文档中的 SDK 可创建 server 与 client，也能只创建网络客户端 | 服务化是可选集成形态，不是所有 runtime 的前提 |
| [OpenCode V2 SDK](https://opencode.ai/v2/docs/build/sdk) | 在宿主内通过内存 HTTP router 复用服务行为，并显式关闭资源；页面标注为 beta | 内外调用共用业务语义值得参考；thread 目前没有必要为了进程内调用先实现 HTTP router |
| [Claude Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript) | Query 提供流、interrupt 和 close；选项支持工具配置与执行限制，底层带有 Claude Code 进程 | “有 SDK”不一定意味着“纯进程内内核”；不应把进程管理成本当作必须复制的设计 |
| [Claude 工具权限](https://code.claude.com/docs/en/agent-sdk/permissions) | 工具可见性、允许/拒绝规则、运行时审批存在不同语义；子 agent 权限有继承规则 | 工具集合与调用策略需要分清；thread 可以采用更少的策略层，但作用范围必须明确 |
| [Vercel UIMessage](https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message) / [ModelMessage](https://ai-sdk.dev/docs/reference/ai-sdk-core/model-message) | UI 所需消息信息与传给模型的信息分别建模 | thread 应保留会话事实、模型上下文、展示状态三个概念，避免直接把压缩后的上下文当成完整聊天记录 |
| [Vercel ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) | 使用工具循环，并提供 stopWhen、activeTools 等控制点 | 当前 TurnRunner 的循环结构可以保留，补小型限制选项即可 |
| [LangGraph Functional API](https://docs.langchain.com/oss/javascript/langgraph/functional-api) | 持久化执行涉及任务结果保存、确定性和副作用幂等；未完成任务在恢复时仍可能再次执行 | 有日志并不等于可以安全重放任意工具，自动崩溃续跑应作为单独能力 |
| [ACP 架构](https://agentclientprotocol.com/get-started/architecture) / [Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn) | 标准化客户端与 agent 的会话、更新、权限和取消交互 | 需要编辑器集成时优先评估 ACP 适配；它不应决定内部存储和调度实现 |
| [AG-UI Events](https://docs.ag-ui.com/concepts/events) | 区分运行、文本、工具与状态事件，并有 snapshot/delta 模式 | 可以参考事件身份与同步方式；使用它不要求将内部 Session Tree 改成 AG-UI 状态模型 |
| [MCP 架构](https://modelcontextprotocol.io/docs/learn/architecture) | MCP 负责上下文交换，不规定应用怎样调用 LLM 或管理上下文 | 接外部工具时用 MCP 适配器；MCP 本身不替代 runtime 控制接口 |
| [Anthropic：Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | 提倡简单、可组合的实现，复杂度应由效果和需求驱动 | 保留已工作的工具循环；避免为了“agent runtime”名称加入框架 |
| [Anthropic：Managed Agents 架构](https://www.anthropic.com/engineering/managed-agents) | 将执行 harness、工具环境和会话日志分离，强调会话历史不等于上下文窗口 | 支持 thread 已有的历史与上下文分离；云端部署方式和弹性调度不属于当前必需项 |
| [Martin Fowler：YAGNI](https://martinfowler.com/bliki/Yagni.html) | 推迟推测性功能不意味着推迟让代码更容易修改的重构 | 独立入口、生命周期修复现在做；没有消费者的通用平台能力以后做 |

这些资料覆盖了进程内库、子进程 SDK、客户端协议、UI 流、持久化工作流与托管服务，不能因为都叫 agent SDK/runtime 就把它们视为同一个层次。

版本注意：OpenCode 旧 SDK 文档、V2 beta 文档和本地 `sdk-next` 处于不同接口阶段；它们共同支持“行为复用”，不代表入口名称可以混用。部分网页为持续更新文档，本文记录的是调研当日的架构语义。未成功直接提取的 Vercel/Claude 参考页面，使用了其官方域名的索引正文与相关官方说明交叉核实；不把检索摘要里的具体签名当成已验证的可运行代码。

## 2. 对上一轮建议的收敛

| 上一轮关注点 | 现在的建议 | 引入更复杂实现的条件 |
| --- | --- | --- |
| 关闭和锁的正确性 | 立即修复；属于现有错误 | 无需等待新 UI |
| 显式 session 身份 | 公共操作带 sessionId，客户端保存 selectedSessionId | 不必同时实现多会话并发 |
| 多会话执行协调 | 首版继续保持一个项目只有一个前台执行，忙时返回明确错误 | 实际需要同一项目多个任务同时运行 |
| RuntimeEvent | 现在从展示层抽离，补齐身份及完成语义 | 持久化事件重放等 Web 重连需求出现再做 |
| 交互请求服务 | 移出 ui 目录、明确所有权，继续使用现有 AskPresenter/AskService | 服务端长期挂起、重连后继续回答时再加可查询请求管理 |
| 存储接口 | 先把路径和依赖装配交给宿主；保留 JSONL | 第一个内存、数据库或外部存储消费者出现时再抽所需接口 |
| 执行环境接口 | 先允许完全自定义工具集合，复用现有 AgentTool | 出现容器、SSH、虚拟文件系统等第二种实现时再抽 FileSystem/Shell |
| 独立包 | 同一个 npm 包中先分 runtime 与 TUI 导出入口 | 安装体积、平台依赖或发布周期产生实际冲突 |
| Run/Session/Host 多层对象 | 保留现有 Session、Turn、Entry 概念；一个公共控制入口足够 | 明确出现不能用 Turn 表示的执行生命周期 |

“每个项目一个前台执行”可以是一项被写清楚的能力限制；“UI 当前选中谁就改变所有调用者的目标会话”则是需要清理的接口耦合。这两件事应分开处理。

## 3. 建议的最小结构

三个职责边界足够，不要求三个独立包：

```text
TUI / CLI / 嵌入宿主 / 将来的 Web 适配器
                    |
              公共 runtime API
                    |
      现有会话服务、TurnRunner、AgentStepRunner
                    |
          模型、工具、日志及文件历史

CLI/TUI 启动处显式装配产品默认配置：
基础工具、提示词、Skills、Recall、GlobalMemory、文件 checkpoint
```

产品默认配置直接传给统一 runtime；不再增加另一层命名为 coding runtime 的创建函数，也不需要插件容器、依赖注入框架或配置语言。主 agent 和 worker 可以继续保留不同的循环策略；它们已经通过 AgentStepRunner 和 ExecutionJournal 共享执行机制，不必为了统一命名合成一个参数很多的万能 runner。

具体对应当前代码：

- [ThreadApp](</D:/WORK/projects/thread/src/app/thread-app.ts:69>) 中与运行、配置、会话操作有关的内容成为公共控制入口。
- [InputRouter](</D:/WORK/projects/thread/src/app/input-router.ts:1>)、命令解析、picker、composer 和 clear 留在客户端适配层。嵌入式 prompt 应按输入原文运行，不解析 `/new` 之类命令。
- [createAgentRuntime](../src/runtime/create-agent-runtime.ts) 负责每轮执行器的普通对象装配；产品默认配置在 `ThreadApp.open()` 中声明，不增加服务定位器。
- [AgentStepRunner](</D:/WORK/projects/thread/src/agent/step-runner.ts:41>)、[ExecutionJournal](</D:/WORK/projects/thread/src/agent/execution-journal.ts:15>)、工具调度、上下文压缩和文件回退继续使用。
- [入口文件](</D:/WORK/projects/thread/src/index.ts:142>) 将 TUI 的静态导出移到单独子入口，让 runtime 导入不需要加载 OpenTUI。单独子入口解决模块加载边界；若要减少必装原生依赖，还需另行调整依赖或分包，不能把两者混为一谈。

### 一个公共 API 即可

下面只是说明调用关系的草图，名称可以沿用现有代码。它不是需要一次落地的完整 SDK 规范。

```ts
interface ThreadRuntime {
  createSession(): Promise<ProjectSession>;
  prompt(
    sessionId: string,
    input: string,
    options?: {
      signal?: AbortSignal;
      maxSteps?: number;
      timeoutMs?: number;
    },
  ): Promise<TurnResult>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  interrupt(sessionId: string): Promise<void>;
  close(): Promise<void>;
}
```

现有图片输入、模型设置、会话读取、compact、rewind 等功能继续通过对应的类型化方法暴露，草图省略它们以突出边界。无需另外建立 CommandBus，也无需先引入 AsyncIterable 与 callback 两套独立实现；沿用一个事件发布出口，确有消费者时加薄转换即可。

Session Tree 和 model 元数据可以通过只读查询返回。不要让新 UI 依赖可写 projection、repository 或 tools 内部容器；runtime 内部使用具体类没有问题，抽象重点是宿主会替换的部分。

## 4. 现在应落实的行为契约

### 4.1 完成、取消与关闭

`prompt()` 成功返回时，该 turn 必需的工具收尾、历史封口与持久化屏障已完成；可选 Recall 索引等后台工作可以继续。`interrupt()` 请求取消并等待目标执行结算；`close()` 拒绝新输入、取消并等待自己拥有的执行，再关闭自己的资源。重复 close 返回同一个结果。

这是可测量的行为，不要求引入状态机库。一个关闭 Promise、明确的运行状态和所拥有的任务集合就能表达。运行结果继续区分 completed、interrupted、failed；存储失败不能伪装成正常完成。OpenAI 的 completed 说明和 ACP 的取消完成要求提供了直接参考。[流式完成语义](https://openai.github.io/openai-agents-js/guides/streaming/)、[ACP 取消](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation)。

本轮会话上一阶段已经用隔离假模型复现两个问题：

1. [ThreadApp.close](</D:/WORK/projects/thread/src/app/thread-app.ts:906>) 返回后主任务仍运行，模型返回时持久化失败。
2. [Repository.close](</D:/WORK/projects/thread/src/session-tree/repository.ts:198>) 重复删除锁，旧实例可能移除新实例的锁。

第二项除幂等关闭外，还需要只由持锁实例释放锁，并在关闭后立即拒绝新写入。

取消是协作式的：宿主提供的工具必须响应 signal 并最终结算。超时设置不能强杀任意进程内 JavaScript；不能以 Promise.race 的超时返回来冒充工具已停止。如果今后要求强制终止不合作的工具，再引入可终止的进程或执行环境边界。

### 4.2 宿主配置有明确覆盖语义

首版仅需清晰表达以下几项：

- 数据目录可显式指定，不要求嵌入宿主修改进程级 THREAD_HOME。
- 基础工具通过名称选择，自定义 `AgentTool` 可在同一数组中提供；默认空集合，重复名称报错。
- systemPrompt 的“替换”和“追加”语义明确。纯自定义配置不应继续自动追加文件编辑和全局记忆指令。
- Skills 只加载宿主声明的路径或注入的数据，自动追加可调用 Skill 的目录；Recall、GlobalMemory、Dreamer 按需启用。TUI 的默认体验由 CLI 启动配置提供。
- 文件 checkpoint 可关闭，但会话持久化、工具路径检查和同路径写入协调保留。每轮记录开关状态，文件恢复不能跨越没有 checkpoint 的轮次；仅会话回退不修改文件。
- runtime 创建的资源由它关闭；宿主注入的共享模型客户端、存储或连接，默认由宿主拥有。不要替宿主关闭被其他实例使用的资源。

pi 的工具选择和资源配置说明支持这些扩展点，但 thread 不必把其全部 ResourceLoader 方法复制过来。[pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)。

### 4.3 工具策略覆盖所有执行者

当前 [worker 创建空 ExtensionEvents](</D:/WORK/projects/thread/src/agent-task/task-runner.ts:68>)，所以主 agent 的 before_tool_call 不能被当作宿主级全局策略。

最小方案是一个可选的宿主授权回调，传到所有 ToolCallExecutor，携带 sessionId、turnId、agent/profile 身份、toolCallId 和最终参数。参数规范化或扩展改写完成后，对最终将执行的调用做策略检查。普通扩展不能再扩大宿主明确拒绝的权限。

这不是要求添加一套复杂权限产品。只需分清工具是否可见、调用是否允许、是否需要人回答，并让默认行为沿用现有产品选择。Claude 的官方权限说明也显示，名为 allowedTools 的选项实际上可以是“预批准”，而非工具白名单；设计 thread 的字段时应避免这种歧义。[Claude 权限语义](https://code.claude.com/docs/en/agent-sdk/permissions)。

工具策略也不是进程沙箱。自定义工具及允许执行的 Shell 仍具有宿主授予的系统能力，不能把回调当作隔离任意不可信代码的机制。

### 4.4 事件属于执行领域，渲染批处理属于 UI

把 [UiEvent](</D:/WORK/projects/thread/src/ui/events.ts:10>) 中的 agent 事件移到 runtime 侧；UiEventBatcher 留在 TUI。补齐 sessionId、turnId；消息增量使用 entryId，工具事件使用 toolCallId。必要的 model retry attempt 标识留在步骤事件里，不必新增全局 Run 实体。

事件有两种性质，应写在类型说明或 API 文档中：实时进度可被合并，已提交事实用于确认状态。尤其当前 repository 的非 flush append 会先更新内存投影再排队写盘，不能把“看见投影变化”直接宣称为“已持久化”。

subscribe 是观察接口：取消订阅不取消执行；观察者抛错不能改变持久化结果。会改变执行的扩展 hook 使用独立调用路径。context_updated 等事件可以返回估算 token 数和窗口大小，百分比、颜色和提示语由 UI 计算。

Codex 的对象身份和 AG-UI 的事件分类是参照，但不需要直接以其协议类型作为 thread 的内部数据模型。[Codex App Server](https://developers.openai.com/codex/app-server/)、[AG-UI Events](https://docs.ag-ui.com/concepts/events)。

### 4.5 等待人类输入先维持简单实现

现有 [AskPresenter / AskService](../src/runtime/interaction.ts) 已经提供了 Promise、request ID 与取消能力。它们已迁到 runtime 并补充执行身份和所有权，不需要立即把 Promise 挂起改成持久化工作流。

断开展示连接、用户拒绝回答、运行取消是不同结果；不得把其中一种默认为另一种。没有交互能力时不暴露 ask 工具，避免内核永久等待。长期等待、进程重启后继续回答等需求出现时，再设计请求列表、回答去重、过期和持久化。

### 4.6 小型执行预算

[主循环](</D:/WORK/projects/thread/src/agent/turn-runner.ts:63>) 可以继续使用普通 for 循环，补 maxSteps 与 timeoutMs，并在结果中明确限制触发原因。保留宿主主动取消；如果需要 token 预算，再统计主 agent、worker 和 compaction 的总体使用量，不能只统计主模型最终答案。

预算必须说明计数单位：thread 中 Turn 是一次用户请求，而一些 SDK 的 maxTurns 指模型/工具往返。不同框架默认值也不同，不宜照抄某个数字。OpenAI、Claude 和 Vercel 都提供类似控制点；建议可配置，并让现有 CLI 默认策略显式化。[OpenAI 运行选项](https://openai.github.io/openai-agents-js/guides/running-agents/)、[Claude 循环限制](https://code.claude.com/docs/en/agent-sdk/agent-loop)、[Vercel ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)。

## 5. 保留的设计，以及暂缓的能力

### 5.1 保留 Session Tree，不改成另一套聊天列表

thread 的 Session Tree 保存原始会话、工具事实和分支；ContextBuilder 从中构造本次模型上下文；UI 再做展示投影。这个方向合理。Anthropic 最近的架构文章强调可恢复的会话记录应独立于上下文管理；Vercel 也区分 UI 和模型消息，但两者的具体数据模型不必照搬。[会话与上下文](https://www.anthropic.com/engineering/managed-agents)、[UIMessage](https://ai-sdk.dev/docs/reference/ai-sdk-core/ui-message)。

模型上下文压缩不减少整个历史日志的体积。先测量打开项目耗时、峰值内存和 context build 耗时；出现实际瓶颈时，再引入历史分页、检查点或 SQLite。仅为了“以后可能是服务”就替换 JSONL，会增加数据迁移、事务和回退语义的工作。

### 5.2 浏览器重连与进程崩溃恢复是两件事

第一版 Web 接入可以通过当前运行状态、消息快照和待回答请求恢复页面，不必保证逐 token 重放。若快照和订阅分两次获取，应处理二者之间漏事件的竞态，例如由服务端原子地返回快照及后续订阅，或先订阅缓存、获取带版本的快照后衔接。简化不能以偶发丢数据为代价。

如果任务应在浏览器关闭后继续，执行寿命不能直接绑定 HTTP 请求的 signal；停止按钮应调用明确的取消操作。Vercel 当前 resume-stream 文档中的 abort 限制是其实现组合的限制，不能推导为所有 runtime 都不能同时支持重连与主动取消。[Vercel 重连限制](https://ai-sdk.dev/docs/troubleshooting/abort-breaks-resumable-streams)。

进程崩溃后恢复执行则更复杂。例如工具已向外部系统提交操作、结果尚未写回日志，此时仅看“调用已记录”无法判断是否应该再执行。LangGraph 的恢复要求讨论了任务重放和幂等问题，这也说明追加日志本身不能提供外部副作用的 exactly-once 保证。[LangGraph Functional API](https://docs.langchain.com/oss/javascript/langgraph/functional-api)。

thread 首版可以保留当前策略：恢复会话记录，将未完成 turn 标为 interrupted，后续由新输入继续；不要自动重跑结果未知的写工具。若以后提供自动续跑，需要另外定义重试身份、幂等键及不确定结果处理。

### 5.3 协议选择由第一个消费者决定

| 接入需求 | 优先做法 | 暂时不需要 |
| --- | --- | --- |
| Bun 宿主直接嵌入 | 调用 runtime 子入口 | HTTP、RPC、协议协商 |
| Python/Rust 等宿主集成 | 一个薄的进程间适配层，按需要选 stdio 等传输 | 将所有内部类暴露为远程对象 |
| 编辑器客户端 | 评估 ACP session/prompt、update、permission、cancel 适配 | 自己复制一套类似编辑器协议 |
| 自己的 Web UI | 类型化操作、状态读取和一种流式传输 | 一开始同时实现 SSE、WebSocket、AG-UI 全套 |
| 使用现成 AG-UI 前端 | 将 RuntimeEvent 映射到所需事件子集 | 用 AG-UI 重写存储、上下文和工具调度 |
| 外部工具生态 | AgentTool 与 MCP 工具适配 | 用 MCP 代替全部会话控制接口 |

这些映射基于 [ACP](https://agentclientprotocol.com/get-started/architecture)、[AG-UI](https://docs.ag-ui.com/concepts/events)、[MCP](https://modelcontextprotocol.io/docs/learn/architecture) 各自的范围。传输层出现时再加入相应的身份验证、输入校验、有限缓冲和重连策略；不要提前引入一个没人使用的传输框架。

## 6. 最小实施顺序与验收

第一步：修复生命周期和锁。验收为运行中 close 会完成取消和结算；重复 close 不影响后来的持锁实例；关闭后调用立即失败；父任务关闭会等待自己拥有的子任务停止。

第二步：抽出统一公共 runtime 入口，CLI 显式声明自己的默认配置。验收为现有 TUI 和一个小型无界面示例都从公共 API 调用，不读取可写 projection、不发送斜杠命令替代操作；示例混用选定内置工具、自定义工具和声明路径的 Skill，使用显式数据目录，不读取默认全局记忆。

第三步：补齐领域事件、交互能力、策略传递和预算。验收为观察者异常不会中断执行；主任务和 worker 都遵守宿主策略；取消正在等待的问题能结算；事件能唯一定位所属会话、turn 与条目；模型持续要求工具时能够按配置停止。

构建边界验证应从包的公开导出运行示例，而不只是在 src 相对导入下测试，避免隐藏的 TUI preload 或私有入口掩盖嵌入问题。无需为每个新 interface 写镜像式单元测试；优先验证以上端到端行为。

完成这三步即可交付一个明确受支持的嵌入版本。随后选择一个真实消费者，再决定 Web、ACP、其他语言或第二种存储后端。暂不引入图调度、分布式队列、租约、多租户平台、全量事件重放、通用文件系统接口或自定义插件 DSL。

## 7. 本次调研的验证边界

2026-09-07 的调研阶段只新增网络资料和设计文档，并复查关键本地接口，没有修改 runtime 源码，也没有运行真实模型。当时的类型检查与 9 项针对性测试通过，以及两个隔离关闭复现，不代表第三方 beta SDK 已做运行验证。

后续 runtime 实现以“现有 TUI + 一个独立嵌入示例共用公共 API”为完成条件。离线示例使用脚本模型，验证真实工具执行、公开包导出及无终端导入依赖；不以此声称验证了真实模型提供方、网络工具服务或尚未实现的 MCP。
