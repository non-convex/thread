# Thread 代码审查

- 审查日期：2026-10-18
- 基线：`80c28c5`（工作区含未提交的后台 shell 任务实现：`bash-execution.ts`、`bash-jobs.ts`、`/jobs`）
- 验证：`bun run check` 通过（`tsc --noEmit`）

审查读了从输入到持久化的主链路：`thread-runtime` → `AgentRunner` → `TurnRunner` / `AgentStepRunner` → tool batch / executor → Session Tree 与 file history；并覆盖了 worker、Dreamer、调度、CLI/app 命令和 TUI 控制器。

总体判断：分层和文档是可信的。Session Tree 的不变量、取消语义、压缩投影的一致性写得很细，核心边界（core 不反向依赖 app/UI）也守住了。问题集中在两类：并发 Session 落地后残留的全局假设，以及“全量历史”在读取路径上没有边界。

## 后续处理

下文保留原始审查描述和当时的行号，当前工作区已做以下处理：

- `/compact` 改为只检查目标 Session；中断事件和终端历史保留原因；删除 `hybrid`、`regular` 旧别名。
- status 使用会话计数，不读取消息；sessions/history 使用 `readHistorySummary()`；plain 恢复当前输出使用 `readActiveTurn()`。会话计数和 Worker task 分组各只扫描一次，移除 task 的重复克隆。TUI 完整历史重建暂未改成增量维护。
- 重试前保存失败助手尝试及工具结果；预检或最终调用核对失败时保留已收到的输出。历史读取、检索和终端历史标注失败尝试；仍保留只读工具提前执行，因此重试可能重复读取。
- README 集中说明默认没有审批层和操作系统沙箱；扩展钩子的失败行为补入接口注释及 runtime 文档。
- 图片外置、日志归档和 Windows ACL 优化暂未实施；ACL 复制失败仍阻止替换文件，不降低权限保护。

核对时还修正了三处判断：`contextSnapshot()` 只克隆压缩后保留的内容，并非再次全量复制旧消息；PowerShell 使用异步 `spawn`，开销在写入等待路径上，不是同步阻塞事件循环；`yaml` 并非唯一使用版本范围的依赖，CI 和发布已使用冻结锁文件，因此本次不调整依赖版本。

## P1：另一个 Session 在跑时，`/compact` 必然失败

`ThreadRuntime.compact()` 按 Session 入场，`operate(sessionId)` 只要求目标 Session 空闲（`src/core/runtime/thread-runtime.ts:606`）。但执行时 `TurnRunner.compactActive()` 调用的是不带参数的 `this.tree.requireIdle()`（`src/core/agent/turn-runner.ts:180`）。无参的 `requireIdle` 检查 `runningTurnsBySession.values().next()`，也就是任意 Session 的 running turn（`src/core/session-tree/service.ts:499-506`）。

复现：A 会话空闲、B 会话正在执行一轮；切到 A 执行 `/compact`。入场通过，随后报 `Turn <B 的 turn> is still running`。这是并发 Session 加入后遗留的全局假设，其他入场点（`planTurn`、`runWithDeadline`、`moveLiveTipForRewind`）都已按 Session 检查，只有这里漏了。

修复：`this.tree.requireIdle(options.sessionId)`。

## P1：历史读取没有增量边界，UI 每个回合做两次全量深拷贝

模型上下文会因压缩变小，但历史读取不会。

- `readSession()` 用 `structuredClone` 返回整条 live path 的 turn 和 entry（`thread-runtime.ts:276-287`）。`entries` 包含已经被压缩进摘要的原始消息，也包含图片 base64。
- 同一个方法对每个 turn 调用 `agentTaskDetailsForTurn`，后者扫描全部 worker task 并克隆完整 trace（`thread-runtime.ts:787-790`），复杂度是 turn 数 × task 数。
- TUI 在每次 `turn_finished`、会话切换、命令改变状态后调用 `syncTranscript()` → `readSession()`（`src/ui/terminal/controller.ts:649-653`）；紧接着 `refreshMeta()` 又调用 `contextSnapshot()`，把同一批消息重建一遍。
- plain 模式在每个 `runtime_status busy:true` 都调用 `readSession()`，只为恢复“已收到的文本”（`src/ui/plain/runner.ts:57-60`）。
- `/thread status`、`/thread sessions`、`/thread history` 都调用 `readHistory()`（`src/app/commands/builtins.ts:17,57,110`），为了打印几个计数和请求标签而克隆整个项目历史；`listSessions()` 还要为每个 Session 扫描全部 turn 来计算 `turnCount`（`thread-runtime.ts:266-274`）。

一条 500 回合、平均 60 KB 消息的会话约 30 MB，每回合结束克隆两次，并随每次全量 UI 刷新重复。压缩不会降低这个成本。

建议：给 `readSession` 增加“只返回元数据 / 只返回指定区间”的入口，或让 TUI 基于事件增量维护；`readHistory` 不应被用来取计数。

## P2：Session Tree 日志只增不减，启动时全量重放

`events.jsonl` 是纯追加的，没有轮转、压缩或导出机制。

- `EventLog.append` 先把记录应用到投影，再入队写入（`src/core/utils/event-log.ts:40-48`）；日志本身从不重写。
- 启动时 `readLogLines` 把整个文件读进内存并按行 split（`event-log.ts:5-21`），`SessionTreeRepository.load` 再逐行 `JSON.parse` 并同步应用（`src/core/session-tree/repository.ts:37-45`）。启动耗时和峰值内存随项目寿命线性增长，而且全程阻塞事件循环。
- 图片是主要放大器：`view_image` 和粘贴图片把 base64 直接存进 message entry（单张上限 8 MB，`src/core/images/prepare.ts:1`），一张 8 MB 图在日志里约 10.7 MB。这些字节同时常驻 `projection.entries`，并被上一条里的每次读取复制。
- 压缩只改变模型上下文，不改变存储；`cleanupFileHistory()` 只回收 file-history blob，Session Tree 没有 GC。

现在的设计会先撞到启动和内存，而不是模型上下文。可选方向：图片走内容寻址 blob、消息只存引用；或提供日志分段/归档，启动只重放最近的段。

## P2：模型重试时，工具事实是持久的，模型响应不是

`ToolCallExecutor.prepare()` 在流式阶段就把 `tool_execution` 写进树，作为副作用前的持久化屏障（`src/core/agent/tool-call-executor.ts:168-175`）。模型尝试失败触发重试时，`ToolExecutionBatch.restartForModelRetry`（`src/core/agent/tool-execution-batch.ts:168`）只清内存状态，不清理已写入的记录。

后果：

- 这些记录指向一个永远不会被追加的 `assistantEntryId`。`session_read` 的 `toolCalls` 视图和 recall 索引会把它们当成真实调用展示/检索，但会话里没有对应助手消息。
- 重试会重新执行已经开始的只读工具。`webfetch`、`websearch`、`session_search` 都声明为 `effect: "read"`，可以在助手响应持久化前启动；一次失败重试就会重复发起网络请求。

同一处还有一个方向相反的问题：`reconcile()` 或 `prepare()` 抛错时，`journal.appendAssistant` 还没执行（`src/core/agent/step-runner.ts:114-116`）。用户已经看到的流式文本不会被写入历史，工具调用事实却已经落盘，回合最终只剩一个占位助手消息。扩展钩子抛错也能触发这条路径。

建议：响应已生成但批处理协调失败时，至少以错误状态持久化响应，而不是整体丢弃；失败的尝试需要可区分的 attempt 标记，避免孤儿事实混入历史视图。

## P2：Windows 上每次覆盖写都同步启动 PowerShell，实测约 180 ms

`atomicFile` 在 `overwrite !== false` 时调用 `copyWindowsAccess`（`src/core/utils/atomic-file.ts:58-60`、`8-38`），完整启动 `powershell.exe` 执行 `Import-Module` + `Get-Acl` / `Set-Acl`。`file-write.ts` 对已有文件的写都传 `overwrite: true`，所以每一次 `edit` 和覆盖 `write` 都要付这个成本。

本机用同样的脚本测得 181 ms、186 ms 两次（单独启动 PowerShell 约 85 ms，脚本本身再加约 90 ms）。一个二十次编辑的回合会多花三秒多，并且这段时间在写入关键路径上。

脚本里 `$ErrorActionPreference = 'Stop'`：一旦 `Get-Acl` / `Set-Acl` 因权限、网络盘或受限 PowerShell 环境失败，整个文件写入失败，尽管写内容本身没有问题。

方向是对的（Windows rename 不复制 DACL），但可以考虑：只在源文件确实有非继承 ACL 时调用、把失败降级为警告，或改用原生 API。

## P3：扩展钩子的失败语义不一致

- `before_context` 抛错 → `extendContext` 抛出 → 整个回合失败（`turn-runner.ts:193-200`）。
- `before_tool_call` 抛错 → `prepare` 拒绝 → 批处理 `reconcile` 抛出 → 已生成的模型响应被丢弃（`tool-call-executor.ts:109`）。
- `turn_start` 抛错 → 回合失败（`runner.ts:80`）。
- `tool_result` 抛错 → 被吞掉，只把错误文本追加到模型内容（`tool-call-executor.ts:271-283`）。
- `turn_end` 抛错 → 被 `.catch(() => undefined)` 吞掉（`runner.ts:127`）。

宿主扩展的一个 bug 可能让整轮失败并丢掉模型响应，也可能完全无感。如果这是有意分层（转换类钩子是承重的，观察类可忽略），应在 `ExtensionEventMap` 的注释里写明；否则应统一隔离策略。

## 小问题

- `turn_finished` 对 interrupted 回合不带 `error` 文本，只带 `limit`；TUI reducer 又只根据 `outcome` 显示 “Interrupted”（`src/ui/reducer.ts:153-157`）。达到 `maxSteps` 或超时的回合在 TUI 里看不到原因；plain 模式因为直接读 `TurnResult.error` 反而正常。
- `--tui hybrid` 和 `--tui regular` 会被静默当成 fullscreen（`src/cli/main.ts:77`），但帮助文本和报错都只说 `fullscreen|plain`。这属于项目规范里明确不保留的旧别名。
- `package.json` 中其他依赖都是精确版本，新加的 `yaml` 是 `^2.9.0`，与周边不一致；若依赖精确锁定保证可复现，应改为精确版本。

## 剩余风险：无审批层的默认权限

coding app 默认启用 `bash`，但从不传 `toolPolicy`，也没有审批/确认层；`protectedWritePaths` 只保护内置 `write` / `edit`，`bash` 完全绕过（文档已多处说明）。同时系统提示明确告诉模型可以修改 `~/.thread/config.json`、skills 和全局记忆，而 `webfetch` / MCP 会引入不可信内容。

这不是实现 bug，而是当前最大的剩余风险：间接提示注入可以直接落到一条无确认的 shell 命令上。如果这是有意的取舍，值得在 README 的安全模型部分写成明确的一句话（没有沙箱、没有审批），而不是只分散在各工具的说明里。

## 审查覆盖范围

已细读：runtime 与 admission、agent 循环、tool batch/executor、文件写入边界、Session Tree service/projection/repository、event log、file history、compaction、builtin tools、worker orchestrator/runner、Dreamer 与调度主路径、CLI 启动、app 命令、TUI controller/reducer。

未逐行覆盖：Solid 组件渲染细节、`@zvec/zvec` 与 onnxruntime 原生层、模型目录与凭据存储的全部路径、`patches/` 中两个依赖补丁的具体行为。这些区域只做了接口和调用点级别的检查。
