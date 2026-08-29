# thread 重构方案：用 Session Tree 统一 context branch 与 squash

## 0. 这次重构最终要得到什么

thread 目前把上下文压缩当成一种特殊的消息构建规则：日志仍然保留完整父链，
`buildContext()` 读到 compaction 条目后，再临时跳过它之前的内容。

这能工作，但它让“当前上下文是什么”同时取决于两件事：

- entry 的父子关系；
- `buildContext()` 是否正确识别了某个特殊屏障。

本次重构要把这两套规则合并为一套：

> **当前 entry path 本身就是当前上下文。**

同时，一个 Git worktree 只保留一棵 Session Tree。`/new` 不再在树外创建另一份持久化会话，
而是在同一 genesis 下创建“当前 workspace、空 context”的新 branch。

压缩不再意味着“在原路径上放一个屏障”，而是创建一条新的 entry path。
旧路径仍在追加式日志和旧 checkpoint 中，可以审计、比较和恢复；当前路径不再经过它。

从用户视角看，最终保留两个入口：

- `/compact`：从根开始重建一条短路径，用于手动压缩和自动防溢出；
- `/thread squash`：由用户选择当前路径上的某个历史用户回合，只折叠它到现在之间的内容。

两者使用同一个 squash 原语，但摘要类型、父节点和后续行为不同。

这份文档描述重构完成后的 should-state。实现期间如果代码与本文冲突，以本文为目标；
如果实现发现本文的不变量无法同时成立，应先修正文档，而不是私下增加例外。

---

## 1. 范围与非目标

### 1.1 本次要做的事

本次重构覆盖：

- 新的 `squash` session entry；
- 根式 `/compact`、78% 自动压缩和 context overflow 后的兜底压缩；
- 面向用户的 `/thread squash`；
- squash checkpoint、reflog 元数据和轻量恢复线索；
- 朴素的 entry path 上下文构建；
- 摘要 fork、机器 diff、缓存约束和上下文预算；
- history、rewind、TUI transcript 和 commit 上下文占比；
- 单 Session Tree 持久化，以及 `/new` 的 root-parent/current-workspace/empty-context 语义；
- 新数据格式的明确版本边界与失败提示。

### 1.2 本次明确不做的事

以下能力不在本次范围内：

- 不把 squash 暴露为 agent tool；
- 不让主 agent 自主决定折叠点；
- 不实现 squash 的一键反向操作；
- 不为对话实现逐条 rebase；
- 不改 `MergeService` 的三路工作区合并和现有上下文策略；
- 不引入后台 agent、子 agent 或新的并发执行模型；
- 不为了假想需求增加通用历史改写框架。
- 不保留 Project Catalog、`/session` 或多 Session Tree 切换层。

目标是让代码和状态空间都更小，而不是借重构建立一套通用版本控制语言。

---

## 2. 两张图，以及 squash 真正发生在哪里

thread 有两张相关但不同的图。

### 2.1 checkpoint 图：工作区谱系

`InternalCheckpoint.parentCheckpointIds` 构成 checkpoint DAG。

它描述：

- 工作区快照如何演进；
- branch HEAD 指向哪里；
- `/thread log`、restore、diff 和 merge 如何寻找共同祖先。

checkpoint 可以有多个父节点，因为工作区允许 merge。

### 2.2 entry 图：对话谱系

`SessionEntry.parentId` 构成单父 entry tree。

它描述：

- 当前对话从哪些 entry 演进而来；
- `buildContext()` 应该给模型发送哪些消息；
- 分叉后哪些对话仍在当前路径上。

对话不能像代码 diff 那样逐条重放。assistant 的回复依赖它当时看到的整个前缀，
把旧回复原样“应用”到另一段历史上并没有稳定语义。因此本次只实现 squash，不实现对话 rebase。

### 2.3 两张图唯一的结构连接

两张图通过 `InternalCheckpoint.sessionHeadId` 连接：

```text
checkpoint ── sessionHeadId ──> entry leaf
```

这个连接已经足够。

`squashFromEntryId`、`squashSourceHeadId` 等字段只是观测和恢复元数据，
不能被当作新的图边。entry 的结构只看 `parentId`，checkpoint 的结构只看
`parentCheckpointIds`。

### 2.4 squash 的定义

squash 同时保持两件事：

- 工作区保持在当前的 checkpointed 状态；
- 一段对话历史被一条摘要替代。

它在两张图上的动作不同：

- checkpoint 图继续向前追加一个单父 checkpoint；
- entry 图创建一条跳过旧对话区间的新路径。

因此 squash 不是删除。旧 entry、旧 checkpoint 和 reflog 都继续存在。

---

## 3. 用户语义

### 3.1 `/compact`：建立新的上下文根

`/compact` 折叠较早历史，并原样保留最近若干完整用户回合。

成功后，当前 entry path 在压缩时刻只有一个根式 squash entry：

```text
squash(parentId = null)
```

这个 entry 内部包含：

- 完整的项目状态摘要；
- ~~checkpointed workspace diffstat~~（已移除，见 6.5）；
- 原样保留的最近消息 `retainedTail`。

后续普通消息再依次追加到它后面：

```text
squash root → user → assistant → toolResult → ...
```

78% 自动压缩和 context overflow 兜底使用同样的根式 squash。

### 3.2 `/thread squash`：从用户选定的位置继续

`/thread squash` 只允许选择当前 entry path 上的真实用户回合。

假设选中的用户 entry 是 `U`，它原来的父节点是 `P`：

```text
P → U → ... → current leaf
```

squash 后变成：

```text
P → squash(incremental)
```

也就是说，`squash.parentId = U.parentId`。

摘要说明从 `U` 到当前状态之间发生了什么。它作为一条合成 user 消息进入一次正常 agent turn，
因此模型会继续回复，工具也可以在随后的正常 step loop 中运行。

如果 `U` 是会话的第一条用户消息，`U.parentId` 同样是 `null`。这种情况下 squash 虽然位于根，
仍然是 `incremental` 摘要，不能仅凭 `parentId === null` 把它误认为 `/compact` 的项目状态摘要。

### 3.3 选择器与历史列表不是同一个候选集

`/thread squash` 的目标必须在当前 entry path 上。否则目标与当前叶子之间不存在一段连续、
可被折叠的区间。

`/rewind` 和 `/thread history` 可以展示不在当前路径上的旧回合，因为它们仍可能通过 checkpoint
恢复。这些回合必须清楚标注为 `off-path`。

因此：

- `/thread squash`：只列 `current-path` 用户回合；
- `/rewind`：可列可恢复的 `current-path` 和 `off-path` 回合；
- `/thread history`：展示两类回合及其状态；
- 不得再仅用 `turn.branchName === currentBranch` 判断候选集。

只按 branchName 过滤会同时产生两种错误：漏掉从父分支继承而来的当前路径回合，
以及混入同名分支上已经被放弃的旧回合。

无参数 `/thread squash` 打开选择浮层。选中后一次 Enter 即确认，不再增加第二层确认。
显式 turn ID 或 user entry ID 仍可用于非交互调用，但解析后必须再次验证它位于当前路径。

内嵌在 squash 的 retained 消息仍引用原 entry 和原 Turn 身份，但它不是当前结构路径上的一等节点，
因此不作为 `/thread squash` 目标。history 应把这种回合标成 `retained`，而不是误标为普通
`off-path`。

### 3.4 `/new`：从 genesis 开始空 context branch

一个 worktree 只有一棵 Session Tree 和一个确定性的 tree ID。`/new` 不创建第二棵树，
也不恢复 genesis 时的文件内容。

执行顺序是：

1. 在当前 branch 无条件写入 safety checkpoint，固定当前 workspace 与 context；
2. 找到唯一的 genesis checkpoint；
3. 在 genesis 下创建自动命名的 `new-N` branch checkpoint；
4. 新 checkpoint 的 workspace tree 与 retention identity 复用 safety checkpoint；
5. 新 checkpoint 的 `sessionHeadId = null`，随后把 current branch 切到 `new-N`。

图上的含义是：

```text
genesis
├── old branch ──► ... ──► safety(current workspace + old context)
└── new-N ───────────────► new(current workspace + empty context)
```

`new` checkpoint 必须记录 `workspaceSourceCheckpointId = safety.id`，使“workspace 从哪里借来”可以审计，
并在 replay 时验证 tree/retention pair 完全一致。checkpoint、branch 创建和 current-branch 切换必须同批落盘。

---

## 4. 数据模型

### 4.1 新的 squash entry

`SessionEntry` 增加：

```ts
type SquashEntry = EntryBase & {
  type: "squash";
  summaryKind: "project_state" | "incremental";
  summary: string;
  workspaceDiffStat: string;
  retainedTail: Array<{
    sourceEntryId: string;
    message: Message;
  }>;
  requestTokensBefore: number;
};
```

字段语义如下。

`summaryKind` 是结构字段：

- `project_state`：根式 `/compact` 或自动防溢出压缩；
- `incremental`：用户选择中间回合的 `/thread squash`。

`summary` 是模型生成的叙事信息。

`workspaceDiffStat` 是程序从 durable workspace tree 生成的事实信息。它必须与摘要分区展示，
不能让用户或后续模型误以为它也是摘要模型写出来的。

`retainedTail` 只在 `project_state` squash 中非空；`incremental` squash 恒为空。
每条消息同时保存原始 `sourceEntryId`。它不是新的图边，也不会把旧 entry 重新接回 active path；
它只是让 Turn、tool record 和 TUI 能识别这条内嵌消息原本来自哪里。
写入时该 source entry 必须已经存在。模型上下文直接使用内嵌的 message，不在构建时反向解引用
source entry，因此 squash payload 仍然是自包含的。

`requestTokensBefore` 记录触发 squash 前用于安全判断的完整 request token 估算，
不是仅消息正文的大小。

### 4.2 父节点就是折叠目标，不再重复保存 target

entry 的结构目标已经由 `EntryBase.parentId` 表达：

- 根式 squash：`parentId = null`；
- 中间 squash：`parentId = selectedUserEntry.parentId`。

因此 squash payload 不再增加 `targetEntryId`。保存两个可以互相矛盾的结构字段只会扩大非法状态空间。

为了支持显式跳转，`SessionService` 增加类似下面的窄接口：

```ts
appendEntryAt(lane, parentId, entry, flush?)
```

它必须验证：

- `parentId` 为 null，或确实存在于同一 session；
- 调用者提供的旧 lane leaf 仍然是它规划 squash 时看到的 leaf；
- 不会形成环。

普通 `appendEntry()` 继续以当前 lane leaf 为父节点，并可内部复用该接口。

### 4.3 为什么 retained tail 仍然内嵌

从纯图形上看，把 retained tail 变成：

```text
squash → copied user → copied assistant → copied toolResult
```

会更接近“一条消息一个 entry”。但不能直接修改原 entry 的 `parentId`：旧 checkpoint 和其他分支
仍然引用这些 entry，修改它们会改写历史。

若复制 entry，则还必须处理：

- 新 entry ID 与旧 `Turn.userEntryId` 的对应；
- tool result 新 ID 与 durable `tool_started.resultEntryId` 的对应；
- 同一个 toolCallId 在日志不同路径上的重复；
- history、rewind 和 TUI 如何识别路径副本。

这些工作远大于本次重构带来的收益。

因此第一版保留内嵌 `retainedTail`。它是 squash entry 的局部数据，不会作为新 entry 再次进入全局
entry、Turn 或工具索引；其中的 `sourceEntryId` 只引用原 entry 的身份。一条 squash entry 可以渲染
成多条模型消息，这是唯一允许的 1:N 映射。

为了让调用者不再依赖 `sourceEntryIds.length === messages.length`，`BuiltSessionContext` 应提供
逐消息来源：

```ts
interface MessageOrigin {
  entryId: string;
  kind: "entry" | "retained";
  containerEntryId?: string;
  retainedIndex?: number;
}

interface BuiltSessionContext {
  messages: Message[];
  origins: MessageOrigin[]; // 与 messages 严格等长
  rootProjectState?: {
    entryId: string;
    summary: string;
  };
}
```

摘要和 diffstat 生成的合成 user 消息以 squash entry ID 为来源。retained 消息的 `entryId` 保持原始
`sourceEntryId`，同时用 `containerEntryId` 指向承载它的 squash entry，并带 retained index。
这样自动压缩发生在 turn 中间时，当前 Turn 的 user entry 虽然不再是结构祖先，TUI 和 history 仍能
确认它被保留在 active context 中。

`rootProjectState` 只在第一条有效上下文消息来自 `project_state` squash 时存在。
后续摘要生成必须读取这个结构字段，不得解析渲染后字符串的固定前缀。

### 4.4 checkpoint 与 reflog 元数据

`CheckpointReason` 增加 `"squash"`。

`InternalCheckpoint.details` 增加：

```ts
interface SquashCheckpointDetails {
  squashFromEntryId?: string | null;
  squashSourceHeadId?: string | null;
  squashTrigger?:
    | "compact_command"
    | "thread_command"
    | "threshold"
    | "overflow";
}
```

含义是：

- `squashFromEntryId`：用户选择的 user entry；根式 squash 为 `null`；
- `squashSourceHeadId`：lane 被改写前真正的 entry leaf；
- `squashTrigger`：触发来源。

`squashFromEntryId` 只能是 entry ID，不能有时保存 turn ID、有时保存 entry ID。

`squashSourceHeadId` 是轻量恢复方案的关键。空闲时 branch HEAD checkpoint 通常已经指向这个 leaf，
旧 reflog checkpoint 可以完整恢复。自动 squash 发生在一个开放 turn 内时，lane 可能已经领先于
branch HEAD；这时 reflog 的 `oldCheckpointId` 只能恢复到 turn base，不能精确代表被折叠的 leaf。

第一版接受这个边界：

- 手动空闲 squash：旧 checkpoint 可完整恢复；
- turn 中自动 squash：原始 entry 仍在追加式日志中，`squashSourceHeadId` 让来源可检查、可追踪，
  但不提供一键恢复。

### 4.5 ThreadCommit 的上下文占比

TUI 已经显示当前上下文占模型窗口的百分比。commit 沿用完全相同的口径，不另造一套“成本”。

`ThreadCommit` 增加必填字段：

```ts
interface CommitContextCost {
  percent: number;
  estimatedTokens: number;
  contextWindow: number;
  providerId: string;
  modelId: string;
  estimatorVersion: string;
}
```

创建 thread commit 时必须有当前模型，并写入该字段。没有模型时命令明确失败，不能产生口径不完整的
commit。

计算必须复用 TUI 当前公式：

```ts
estimatedTokens = estimateContextTokens(buildContext(head).messages).tokens;
percent = Math.min(999, Math.round(estimatedTokens / contextWindow * 100));
```

这里特意保存分子、分母和模型身份，而不只保存一个裸百分比。这样模型切换后可以同时表达：

- 历史事实：创建 commit 时，这段上下文占当时窗口多少；
- 当前参考：同一上下文相对于当前模型窗口大约占多少。

历史 `percent` 永不因换模型而改写。如果要显示“当前模型参考值”，应从 commit 指向的
`sessionHeadId` 重新构建上下文，并用当前模型口径重算；不能只把旧百分比按窗口大小机械缩放，
因为 tokenizer、usage 数据和 estimator 版本也可能变化。

`percent` 是历史 TUI 指标。自动防溢出仍必须用当前模型、system prompt、tools、消息和输出预算
重新计算完整 request，不能直接拿 commit 百分比代替安全判断。

上下文占比属于 `sessionHeadId` 所指上下文头的属性，不是 commit 独有属性。多个 commit 指向同一
上下文头时显示相同数值是正常现象；UI 可以把它们按共享 context head 分组。

---

## 5. 上下文构建

### 5.1 新 entry 的正常路径

对新 `squash` entry，`buildContext(headId)` 只做三件事：

1. 从 head 沿 `parentId` 走到 `null`；
2. 反转为根到叶的顺序；
3. 按 entry 类型渲染消息。

它不再反向寻找“最近的 squash”，也不在遍历中丢弃任何祖先。

`squash` 的渲染是类型本身的局部规则：

```text
一条带明确前缀的 user 摘要消息
随后展开 retainedTail 中的原始消息
```

因此根式压缩刚完成时：

- entry path 长度为 1；
- 模型消息可以多于 1，因为 retained tail 内嵌在这个根 entry 中。

后续 entry 只会在这条新路径上增长。被压缩掉的旧路径不会被 `buildContext()` 遍历。

### 5.2 两种摘要必须结构化区分

`project_state` 渲染为项目状态起点，例如：

```text
[Summary of earlier project-session context]
[Checkpointed workspace changes]
...
[Narrative project state]
...
```

`incremental` 渲染为一次合成用户请求，例如：

```text
[Session history squashed from the selected user turn; workspace preserved]
[Checkpointed workspace changes]
...
[Narrative of the squashed interval]
...
```

两者都用 `user` 角色。原因不是假装内容由用户亲自书写，而是明确告诉模型：这是新路径的权威输入，
不是 assistant 声称自己记得的一段旧回复。

TUI 必须把它显示为 harness 生成的 squash，而不是伪装成用户真的输入了整段摘要。

### 5.3 数据格式边界

本次重构不兼容旧 `compaction` session。保留屏障读取会让 `buildContext()` 永久背负两套语义，
也会让新路径是否正确继续依赖特殊扫描，这与重构目标直接冲突。

因此：

- `SessionEntry` 不再包含 `compaction` 类型；
- `buildContext()` 只有朴素父指针遍历；
- 日志出现不受支持的旧 entry 类型时，在加载阶段明确报错；
- 不做日志就地迁移，也不静默忽略旧 entry。

需要保留的旧项目应在升级前自行导出结果，再由新版本建立新的 Session Tree。这个数据格式断点换来的是更小、
可证明的运行时状态空间。

---

## 6. 摘要生成

### 6.1 fork 的契约

摘要通过当前活对话的 fork 生成。fork 必须保留当前请求的完整前缀：

- 相同的 system prompt；
- 相同且顺序一致的 tool definitions；
- 相同且顺序一致的 messages；
- 在 provider 支持时，相同的 cache key、reasoning 配置和其他影响前缀身份的参数。

唯一新增内容是最后一条包装 user message，也就是摘要指令。

保留 tools 是为了保持真实前缀和尽可能复用 provider prompt cache，不是授权摘要分支使用工具。
包装消息必须明确写出：

> 这是只读的摘要分支。不要调用任何工具。只返回摘要正文，不要返回计划、解释或工具请求。

运行时还要执行第二层约束：

- 摘要 fork 绝不执行工具；
- 如果模型返回 tool call，或没有可用的摘要文本，本次摘要失败并给出明确错误；
- 不得伪造 tool result 后继续；
- 不得静默退回到一个不含 tools 的不同前缀。

提示词负责减少误调用，运行时负责保证误调用永远不会产生副作用。

### 6.2 摘要优先级

工作区中的文件能证明一部分成功结果，但不能证明全部上下文。以下内容往往只存在于对话中：

- 用户的目标、取舍和未完成要求；
- 失败方案及失败原因；
- 外部资料和诊断结论；
- 尚未写入文件的发现；
- 临时约束、风险和下一步。

因此摘要优先保留：

1. 当前目标和用户已经确认的决策；
2. 未完成工作及下一步；
3. 失败尝试、死路和不要重试的原因；
4. 与正确性有关但无法从工作区直接恢复的事实；
5. 已落盘成果的简短索引。

不能笼统写成“成功工作都在工作区里”。只有已经被 durable workspace 表达的成功工作才能依赖文件
恢复；其余重要信息仍必须进入摘要。

### 6.3 两种摘要形态

`project_state` 是完整项目状态，最多 4K tokens，沿用五个稳定区域：

- `Long-term memory`：最多 25 条，重组后保留真正长期有效的信息；
- `Current project state`：当前目标、已完成内容、风险和下一步；
- `Recent user-agent conversation`：最多 10 条，按时间保留关键互动；
- `Lessons learned`：最多 10 条，本次工作中的失败与经验教训，日期精度，与长期记忆同样做过期删除和合并；
- `Notes worth keeping`：最多 10 条，与项目无关但值得留心的用户相关信息，小时精度。

后两个区域刻意从严录入：只记录会改变后续判断或能避免重复犯错的内容，无内容时留空，不得堆积例行结果或泛泛建议。

如果活上下文起点已经有一个 `rootProjectState`，摘要器从结构字段读取它并合并更新，
不得靠识别渲染字符串前缀来猜。

`incremental` 只描述选中用户回合到当前 leaf 之间的增量，最多 2K tokens。它不重新生成完整长期记忆，
因为目标之前的路径仍会原样保留。

### 6.4 指令必须给出精确边界

摘要模型看得到完整活前缀，但它不知道调用者准备保留哪一段。包装消息必须把边界说死。

对 `/compact`：

- 用当前请求中的用户消息序号标出 retained tail 从哪一条用户消息开始；
- 说明这条消息及其后的内容会原样保留；
- 要求摘要只替代边界之前的内容。

对 `/thread squash`：

- 用当前请求中的用户消息序号标出被选中的用户消息；
- 可附带短 excerpt 供人读，但不能只靠文本匹配，因为用户可能重复输入相同内容；
- 说明摘要覆盖该消息到当前 leaf 的完整区间。

边界计算与摘要指令必须来自同一份 partition plan，不能分别计算。

### 6.5 workspace diffstat：事实先于叙事

> **该节已被推翻（后续实现）。** squash entry 不再携带 `workspaceDiffStat`，字段、生成代码
> 和相关预算扣项全部移除。理由：文件级改动量是最容易重新获得的信息——工作区就在那里，
> sidecar 里有每个快照——为它在每一轮的前缀里长期占位不划算，而 agent 需要时可以自行
> 对着工作区事实核查。下面的论证保留为决策记录。

每一次 squash 都生成 `workspaceDiffStat`，包括 `/compact`、自动压缩和 `/thread squash`。

它不是直接拼接不受限的 `git --stat` 输出，而是从 sidecar 的结构化 tree diff 生成稳定、
受限的 diffstat-style 文本。

端点定义为：

- `project_state`：genesis tree → squash checkpoint 复用的 durable tree；
- `incremental`：选中 turn 的 `baseCheckpointId` tree → squash checkpoint 的 durable tree。

输出要求：

- 永远保留总文件数、总新增行、总删除行；
- 最多展开 100 个文件；
- 整段最多 8 KiB；
- 被截断时写出省略文件数和明确的 truncation marker；
- 文件路径按 JSON 字符串转义，避免换行、Markdown 或提示词注入；
- 先展示机器事实，再展示模型摘要。

diffstat 只证明 checkpointed workspace 的文件级变化，不证明改动语义正确，也不替代摘要中的用户决策、
失败经验和外部事实。

自动 squash 可能发生在一个 turn 中间。此时当前 branch HEAD 通常仍是 turn base，当前工具刚造成的
工作区漂移要到 turn result 才会被捕获。因此 diffstat 必须标注为 `checkpointed workspace changes`，
不得声称它精确描述尚未 checkpoint 的实时工作区。当前 turn 的原始对话和工具结果由 retained tail
保住，最终工作区由正常 turn result 捕获。

### 6.6 retained tail 与预算

只有 `project_state` squash 保留 tail。

切点必须落在完整用户回合边界，不能以孤儿 toolResult、半个工具调用或半个任务开头。

预算顺序如下：

1. 计算 system、tools、包装消息和输出安全余量；
2. 为摘要保留上限；
3. 在剩余预算中，从最近完整用户回合向前扩展 retained tail；
4. 至少保留两个最近用户回合；若上下文本来不足以压缩，则 no-op。

压缩后固定 17K tokens 是目标，不是无条件硬不变量。以下情况可以超过目标：

- 两个最小完整回合本身已经较大；
- 固定摘要上限和请求开销在小窗口模型中占比更高。

实现必须区分：

- 预算可满足时，压缩后落在目标内；
- 只能因“最小完整 tail”规则超过目标；
- 无论如何都不能拆散 toolCall/toolResult；
- 如果连安全请求都装不下，应明确失败并提示 `/clear` 或 `/rewind`，不能循环重试。

---

## 7. 三条执行路径

### 7.1 `/compact`：空闲命令，不进入 agent loop

执行顺序：

1. `requireIdle()`；
2. 固定当前 branch、branch checkpoint、lane leaf 和构建后的活上下文；
3. 计算 partition；没有可压缩内容则 no-op；
4. 记录 `operation_started(intent: compaction)` 并 flush；
5. 用精确活前缀 fork 生成 `project_state` 摘要；
6. 再次验证 branch checkpoint 和 lane leaf 没有变化；
7. 从 genesis tree 到当前 durable tree 生成受限 diffstat；
8. 追加 `squash(parentId = null, retainedTail 非空)`；
9. 创建 `reason = "squash"` 的单父 checkpoint，父节点是压缩前 branch HEAD；
10. 新 checkpoint 复用旧 HEAD 的 workspace tree 和 retention commit；
11. checkpoint、branch move 和 `operation_finished` 以现有原子 batch 规则落盘并 flush；
12. 返回简短的 ephemeral 命令结果。

`/compact` 不进入 agent loop，不是因为最后一条消息必然是 assistant。空闲上下文也可能以
`context_merge` 等合成 user 消息结束。真正原因是 `/compact` 是上下文管理命令，摘要本身不是一个
等待 agent 回答的新用户任务。

摘要 fork 失败时记录 operation failure，不追加 squash entry，不移动 branch。

如果 entry 已经 durable、进程却在 checkpoint batch 前崩溃，沿用现有开放 operation 恢复机制：
启动时将当时 lane leaf 附着到 recovery checkpoint。这个崩溃窗口要有故障注入测试。

### 7.2 `/thread squash`：合成一次正常 agent turn

这条路径必须保证 `/rewind` 能真正撤销 squash，也必须避免重复创建 turn base。

执行顺序：

1. `requireIdle()`；
2. 从当前路径解析并验证选中的用户 turn；
3. 固定 branch checkpoint、lane leaf、目标 entry 和活上下文；
4. 用精确活前缀 fork 生成 `incremental` 摘要；这一阶段不改 durable session；
5. 再次验证 branch、checkpoint、lane leaf 和目标路径关系没有变化；
6. 调用正常 turn 的 base capture，捕获当前工作区漂移，得到 `turnBaseCheckpoint`；
7. 从目标 turn base tree 到新的 turn base tree 生成最终 diffstat；
8. 生成 squash entry ID、turn ID 和 run operation ID；
9. 记录 `operation_started(intent: run)`，其中 `originalPrompt` 是最终渲染的 squash user 消息，
   `initialEntryIds` 只含 squash entry ID；
10. 追加 `squash(parentId = selectedUserEntry.parentId, retainedTail = [])`；
11. 在同一 batch 中创建 squash checkpoint、移动 branch 并记录 `turn_started`；checkpoint 父节点是
    `turnBaseCheckpoint`，tree 与 retention pair 直接复用它；Turn 的
    `userEntryId = squashEntry.id`、`baseCheckpointId = turnBaseCheckpoint.id`；
12. 从共享 step loop 开始执行，不再捕获第二个 turn base，也不再追加普通 user entry；
13. assistant、tool 和 turn result 的执行与普通 turn 完全共用。

关键结果是：`Turn.baseCheckpointId` 位于 squash 之前。`/rewind` 到这个 turn 时会同时撤销合成 user
entry 和它之后的工作区变化，而不是回到一个已经包含 squash 的 checkpoint。

`AgentLoop` 应被拆成“准备 turn”和“执行已准备 turn”两层。普通输入与 `/thread squash` 只在准备阶段
不同，真正的模型 step、工具执行、重试、取消和收尾逻辑保持共享。

### 7.3 自动阈值与 overflow：开放 turn 内的安全点

自动 squash 发生在现有 run operation 内，不能创建嵌套 operation。

它不满足 `VersionService.requireIdle()` 的全局 idle 定义，因为一个 Turn 正处于 running 状态。
真正需要的不变量是“quiescent squash safe point”：

- 当前没有模型请求正在流式返回；
- 当前没有工具正在执行；
- 正位于两次 step 之间；
- lane leaf 和 branch HEAD 已被当前 run 独占；
- squash 完成后，同一个 run 从新上下文继续。

自动路径：

1. 使用当前 run 已组装的完整 request 判断阈值或 overflow；
2. 在安全点 partition 当前消息；
3. 用当前 run 的 operation ID 记录 compaction step attempt；
4. fork 生成 `project_state` 摘要；
5. 保存 squash 前 lane leaf 为 `squashSourceHeadId`；
6. 追加根式 squash entry；
7. 创建单父 squash checkpoint，父节点是当时 branch HEAD，复用其 tree/retention pair；
8. 继续同一个 run 的下一次模型调用。

当前 turn 中较新的 user、assistant 和 toolResult entry 会离开 active path，但其消息位于
`retainedTail` 中；原 entry 仍在日志中。

文档和代码都不得再写“所有 squash 只在 idle 时发生”。正确表述是：

- 用户命令 squash 要求 idle；
- 自动 squash 允许在开放 turn 的 quiescent safe point 发生。

---

## 8. 工作区、sidecar 与跨存储安全

### 8.1 squash 原语本身不捕获也不恢复工作区

纯 squash checkpoint：

- 不调用 `capture()`；
- 不调用 `restoreTree()`；
- `workspaceTreeOid` 与它的父 checkpoint 相同；
- `retentionCommitOid` 与它的父 checkpoint 相同。

`/thread squash` 整体仍会在进入正常 agent turn 前执行一次正常 turn-base capture。
这是 turn 的安全语义，不是 squash 原语额外捕获。随后 squash checkpoint 复用这个 turn base 的
tree/retention pair。

`/compact` 不捕获外部工作区漂移。漂移会像普通流程一样在下一个 turn base 被捕获；
命令输出和 diffstat 必须使用“checkpointed”措辞。

### 8.2 retention keep ref 不能随“最新 checkpoint”倒退

checkpoint 上的 `retentionCommitOid` 表示这个 workspace snapshot 由哪个 sidecar retention commit
保护。它不等于全局 keep ref 当前应指向的 tip。

考虑：

1. branch A 捕获了一个较新的 retention commit；
2. 切到较旧的 branch B；
3. branch B 做一次纯 squash，复用旧 retention commit。

如果代码把“最新 checkpoint 的 retentionCommitOid”当成全局 tip，keep ref 会倒退到 B 的旧提交，
后续 GC 可能丢掉 A 的新 snapshot。

因此必须分开两个概念：

- checkpoint snapshot pair：允许复用旧值；
- global retention tip：最后一个真正引入的新 retention commit，只能随新 capture 前进。

每次新的 capture 都必须以当时的 global retention tip 为 retention parent，不能以当前 branch 上较旧
checkpoint 的 retention commit 另开一条保留链。这样一个全局 tip 才能持续保护所有分支引入的
snapshot。

纯 squash 不创建 sidecar 对象，也不得调用 `updateKeepRef()`。这里需要显式跳过调用，不能假设一次
update-ref 会自然成为 no-op。

启动时 reconcile keep ref，应从日志中找到最后一个首次出现的新 retention commit，或等价的显式
全局 tip 记录；验证拥有该 tip 的 checkpoint/tree。不能拿“最后 checkpoint 的 tree”与全局 tip
强行配对。

跨存储顺序继续保持：

```text
新 sidecar 对象 → 可独立读取验证 → session 原子记录 + flush → 更新全局 keep ref
```

纯 squash 没有“新 sidecar 对象”和“更新 keep ref”两步，只追加 session log。

---

## 9. 恢复、history 与 TUI

### 9.1 reflog 应展示什么

squash 记录至少展示：

- trigger；
- `squashFromEntryId`；
- `squashSourceHeadId`；
- 被折叠区间的消息/回合数量；
- `oldCheckpointId → newCheckpointId`。

对手动空闲 squash，可以提示旧 checkpoint 能完整恢复压缩前状态。
对 turn 中自动 squash，只承诺来源可追踪，不显示误导性“一键恢复完整旧 leaf”。

### 9.2 history 必须是路径感知的

构建 history 时先得到当前 `pathTo(activeHead)` 的 entry ID 集合，再给 Turn 分类。

至少区分：

- `current-path`：`turn.userEntryId` 在当前路径上；
- `retained`：user entry 不在结构路径上，但其 source ID 位于当前根式 squash 的 retained tail；
- `off-path`：Turn 仍在日志/checkpoint 历史中，但既不在路径上，也不在 active retained tail；
- `synthetic-squash`：`Turn.userEntryId` 指向 incremental squash entry。

继承自其他 branch 的当前路径回合不能因为 branchName 不同而消失；已经放弃的同名 branch 回合也不能
伪装成 current-path。

### 9.3 transcript 如何显示 squash

根式 `project_state` squash 显示为独立的 context/squash 项：

- diffstat 作为机器事实区；
- summary 作为叙事区；
- retained tail 随后作为最近的原始回合展开；
- 展开项复用各自的 `sourceEntryId`，不生成第二套 entry 或 Turn；
- tool result 也用 source entry ID 查找原 durable tool record；
- 自动压缩发生在当前 turn 中间时，压缩前后的 live transcript 因此能保持同一身份。

`incremental` squash 是一次合成用户边界，但 TUI 不把长摘要冒充成用户原文。建议显示：

```text
session squashed from: <selected user excerpt>
```

其下可展开机器 diff 和摘要。随后的 assistant/tool 输出按普通 turn 显示。

live UI event 与从日志重建的 committed transcript 必须使用同一身份：

- `userEntryId` 都是 squash entry ID；
- event 明确标出 synthetic squash；
- `markStreamedTurnCommitted` 能用同一 ID 对齐，不重复插入一条普通 user 消息。

transcript 最近回合计数把 incremental squash 当作一个用户边界；根式 project-state squash 本身不算
普通用户回合，但它展开的 retained user messages 按原回合计数。

---

## 10. Prompt cache 与成本判断

摘要 fork 复用完整活前缀，是合理的缓存优化。以 OpenAI 为例，prompt cache 依赖相同前缀，
tools 也属于可缓存前缀的一部分；具体行为和可见指标以 provider 当前文档为准：
[OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)。

这里需要坚持三个边界。

第一，缓存命中不是正确性不变量。TTL、请求路由、最小前缀长度、provider 实现和配置变化都可能导致
miss。即使完全 miss，摘要也必须正确，只是成本更高。

第二，不能把某个 provider、某代模型的缓存粒度、读写倍率或 TTL 写成跨 provider 的常量。
文档不再承诺“固定四五轮回本”。真实 break-even 应通过 usage 日志测量。

第三，squash 后的第一次普通请求拥有新的消息前缀。system prompt 和 tools 是否仍能部分命中取决于
provider；移动到新位置的 retained messages 不能假定继续命中原位置的前缀缓存。

经济判断只保留方向性结论：

- 摘要 fork 可能复用大的旧前缀；
- squash 后只需建立一个较小的新前缀；
- 后续有足够回合时通常能摊销；
- 临近任务结束或连续频繁 squash 时可能没有摊销窗口。

安全阈值是防溢出机制，不以“是否划算”为前提。未来若加入轻量后台决策模型，经济性只能影响主动
折叠点，不能取消 78% 与 overflow 安全网。

---

## 11. 日志、故障与并发边界

### 11.1 stale plan 防护

摘要 fork 可能持续较长时间。任何在 fork 前计算的目标都必须在写入前复核：

- current branch 没变；
- branch checkpoint 没变；
- lane leaf 没变；
- `/thread squash` 目标仍在当前路径；
- operation 状态仍允许继续。

不满足时放弃结果并明确报错，不把摘要写到另一条历史上。

### 11.2 持久化顺序

继续沿用 session log 的 append-only、单调 seq 和 batch 内有序投影。

任何 checkpoint 事件出现时，它引用的 entry、父 checkpoint 和 sidecar snapshot 都必须已经能够独立
解析。`operation_finished` 与最终 checkpoint/branch move 同批落盘，避免显示完成但 HEAD 尚未移动。

### 11.3 自动 squash 不创建嵌套 operation

每条 lane 同时只能有一个开放 operation。自动阈值和 overflow 属于当前 run 的 compaction step，
不能在里面再开始 `intent: compaction` operation。

手动 `/compact` 是独立 command operation；`/thread squash` 最终是一条正常 run operation。

---

## 12. 数据格式升级策略

本次采用明确的不兼容升级，不在运行时保留旧结构的读取分支。

- `SessionTree.formatVersion` 固定为 `3`；缺失、format 2 多 session 数据或其他不匹配版本在加载阶段停止；
- `compaction` entry、缺少 `contextCost` 的 commit 和其他旧事件形态不进入新投影；
- 日志遇到不受支持的 entry 类型时明确失败；
- 不重写现有 Session Tree log，不猜测旧字段，也不静默丢弃内容；
- 用户需要继续旧项目时，应在旧版本导出工作结果，再由新版本建立 Session Tree。

实现说明引用文件和 symbol 名称，不依赖易漂移的行号。

---

## 13. 必须保持的不变量

### 13.1 entry 与上下文

- session 上下文只由朴素父指针遍历得到，不存在屏障扫描或第二套读取语义。
- entry 图始终单父、无环，父 entry 必须存在于同一 session。
- 根式 squash 的 `parentId` 为 `null`，成功时当前 path 只含一个 squash entry。
- incremental squash 的父节点是选中 user entry 的父节点。
- `summaryKind` 决定摘要语义，不能从 `parentId` 或文本前缀猜。
- `retainedTail` 只属于 squash entry 的局部 payload，不创建新的全局 entry/Turn/tool 记录；
  每条 retained 消息保留原 `sourceEntryId` 供身份关联。
- `BuiltSessionContext.messages` 与 `origins` 严格等长。
- retained tail 从完整用户回合边界开始，不产生孤儿 toolResult。

### 13.2 checkpoint 与工作区

- 一棵 Session Tree 只有一个无父的 genesis checkpoint；一个 worktree 不存在 Project Catalog 或第二棵树。
- `/new` 先保存当前 branch 的 safety checkpoint，再创建以 genesis 为唯一父节点的 `new` checkpoint。
- `/new` checkpoint 的 context head 必须为 `null`；workspace tree/retention pair 必须与其记录的 safety source 完全一致。
- `/new` 不 restore workspace；checkpoint、branch 与 current-branch 切换同批持久化。
- squash checkpoint 单父，父节点是 squash 执行时当前 branch HEAD 或 `/thread squash` 的 turn base。
- 纯 squash 不调用 capture/restore，复用父 checkpoint 的 tree/retention pair。
- `/thread squash` 的正常 turn-base capture 发生在 squash 之前，且只发生一次。
- `Turn.baseCheckpointId` 指向 squash 之前的 turn base，因此 rewind 能撤销 squash。
- metadata entry ID 不参与 checkpoint 或 entry 的结构遍历。
- 纯 squash 不创建 sidecar 对象、不更新 global keep ref。
- global retention tip 不因在旧 branch 上复用旧 snapshot 而倒退。

### 13.3 执行与安全

- 用户命令 squash 要求 idle；自动 squash 只在开放 turn 的 quiescent safe point 发生。
- 自动 squash 复用当前 run operation，不创建嵌套 operation。
- 摘要 fork 保留 system、tools 和 message prefix，但永不执行工具。
- cache hit 只是优化，不影响正确性。
- fork 或压缩后请求装不下时明确失败，不静默循环。
- 所有写入前验证 fork 期间没有发生 stale branch/path 变化。

### 13.4 观测

- 新 commit 记录创建时的 TUI 上下文占比及其模型/窗口依据。
- context percent 是 context head 的属性，不保证沿 checkpoint 轨迹单调。
- history 区分 current-path、retained、off-path 和 synthetic squash。
- live 与 committed TUI 使用相同 squash entry ID 对齐。

---

## 14. 实现顺序

按下面顺序落地，避免同时存在两套半完成语义。

### 阶段一：类型和纯路径能力

- 在 `domain.ts` 增加 squash entry、checkpoint reason/details 和 commit context cost；
- 在 `SessionService` 增加显式父节点追加接口；
- 为 path validation、无环和同 session 父节点补测试；
- 对不支持的旧 entry 类型提供明确的加载错误。

### 阶段二：上下文构建

- 重写新 entry 的 `buildContext()` 为父指针遍历 + 类型渲染；
- 引入等长 `origins` 和结构化 `rootProjectState`；
- 删除对文本前缀、最近屏障和旧 compaction 的全部依赖。

### 阶段三：统一 squash service

- 实现 partition plan、摘要 fork、diffstat 限制和 stale validation；
- 实现根式和 incremental 两种 parent/summaryKind；
- 写入 checkpoint details；
- 纯 squash 跳过 sidecar capture、restore 和 keep-ref update。

### 阶段四：接入三个调用点

- `/compact`；
- 自动 threshold/overflow；
- `/thread squash` 与 prepared-turn 入口。

拆分 AgentLoop 的 turn preparation 和共享 step loop，确保普通 turn 行为不被复制出第二份。

### 阶段五：history、commit 和 TUI

- 候选集改为 path-aware；
- 补 synthetic squash 的 live/committed transcript；
- commit 写入并展示历史 TUI context percent；
- reflog 展示 source head 和恢复能力边界。

### 阶段六：删除旧特例

- 删除 compaction entry 类型和 barrier scan；
- 确认所有压缩入口只创建 squash；
- 对不支持的旧数据明确失败；
- 更新说明和测试名称，避免继续混用 compact/compaction/squash 的结构含义。

`MergeService` 在所有阶段保持现有行为，本次不借机重写。

---

## 15. 验证要求

验证应围绕不变量，而不是只验证命令返回成功。

### 15.1 entry path 与上下文

- 根式 `/compact` 后 `pathTo(activeLeaf)` 只有一个 squash entry；
- buildContext 输出为 summary + retained tail，后续消息正常追加；
- incremental squash 保留目标之前的路径，只替换目标到 leaf 的区间；
- 选择第一条用户消息时仍产生 `summaryKind: incremental`；
- squash 路径不存在 barrier scan；
- 旧 compaction 日志以明确的不支持错误停止加载；
- `messages` 与 `origins` 一一对应；
- retained origin 保留原 source entry ID，并指向承载它的 squash container；
- 前一份 project state 从结构字段读取，不解析渲染前缀。

### 15.2 目标与恢复

- `/thread squash` 接受 current-path turn，拒绝 off-path turn；
- fork 后路径变更会触发 stale failure；
- inherited current-path turn 不会被 branchName 过滤掉；
- 自动 squash 后当前 turn 被识别为 retained，而不是普通 off-path；
- abandoned same-branch turn 标记为 off-path；
- 手动 squash 的旧 checkpoint 可恢复完整旧上下文和工作区；
- 自动 squash 的 `squashSourceHeadId` 等于改写前真实 lane leaf，即使 lane 已领先 branch HEAD。

### 15.3 turn 与 operation

- `/thread squash` 只捕获一个 turn base；
- squash checkpoint 的父节点是该 turn base；
- `Turn.baseCheckpointId` 是 squash 前的 turn base；
- rewind 该 turn 后 squash entry 不在 active path；
- synthetic turn 的 `userEntryId` 等于 squash entry ID；
- `turn_started`、`turn_finished`、operation recovery 投影通过；
- 自动 squash 可在开放 run 的 safe point 执行，不创建嵌套 operation；
- 模型调用或工具执行进行中时禁止 squash。

### 15.4 摘要、tools 与预算

- fork 收到与活请求一致的 system、tools 和 messages，包装指令只追加在末尾；
- 包装指令明确禁止工具；
- 模型返回 tool call 时没有工具被执行，并得到明确失败；
- fork 装不下时明确提示 `/clear` 或 `/rewind`；
- retained tail 从用户回合边界开始，不拆 toolCall/toolResult；
- 17K 预算可满足时落在目标内；超过时只能来自文档允许的最小完整 tail 例外；

### 15.5 workspace 与 sidecar

- 纯 squash 前后 workspace tree OID 相同；
- spy 断言纯 squash 没有调用 capture、restore 或 updateKeepRef；
- diffstat 两端 tree 选择正确；
- 文件路径经过转义，100 文件和 8 KiB 上限生效；
- 截断后总文件数、总增删行和 omitted count 仍正确；
- branch A 新 capture、切换旧 branch B 做 squash 后，global keep tip 不变；
- 在该状态下运行 sidecar GC，所有 checkpoint snapshot 仍可验证和 materialize。

### 15.6 commit 与 TUI

- 新 commit 的 percent 与当时 TUI 完全一致；
- 保存 estimatedTokens、contextWindow、provider/model 和 estimatorVersion；
- 换模型后历史百分比仍带原模型依据；当前窗口参考值通过重建该 context head 重新估算；
- 创建 commit 时没有模型会明确失败，不产生缺少 contextCost 的新记录；
- 根式 squash 与 incremental squash 使用不同 transcript 表现；
- retained transcript 项复用原 entry ID，tool result 仍能关联原 tool record；
- live synthetic turn 与日志重建结果不会重复；
- history 中 current-path、retained、off-path、synthetic 标记正确。

---

## 16. 已经定案的取舍

以下问题不再留作实现阶段的 TBD：

- retained tail 内嵌在 squash entry，不复制或重挂旧 entry；
- `/thread squash` 只接受当前路径目标；
- off-path 回合仍可在 history/rewind 中看到并明确标记；
- 使用轻量 `squashSourceHeadId`，不在第一版增加自动 squash 的完整一键恢复 checkpoint；
- commit 展示并记录与当前 TUI 同口径的 context percent，同时保存模型窗口依据；
- 摘要 fork 保留 tools 以维持前缀身份，提示词明确禁止工具，运行时绝不执行工具；
- 所有 squash 都带受限 workspace diffstat；
- diffstat 最多 100 个文件、8 KiB，并保留总量与截断标记；
- `/compact` 的摘要上限为 4K tokens，`/thread squash` 的增量摘要上限为 2K tokens；
- `/thread squash` 选择器一次 Enter 确认；
- 固定 17K 是可行时的压缩目标，完整最小 tail 是唯一允许的预算例外；
- 自动 squash 在开放 turn 的安全边界运行，不伪称全局 idle；
- squash checkpoint 复用 snapshot，但 global retention tip 独立维护、不得倒退；
- 不修改 `MergeService`，不增加 agent squash tool。

重构完成的判断标准不是“新增命令能运行”，而是下面这句话在新 session 中真正成立：

> **从当前 leaf 沿 parentId 走到根，得到的就是模型当前应看到的全部上下文。**
