# thread 当前进度

> **维护要求：当实现、修改、移除一项功能，改变关键设计或默认参数，发现或解决重要限制，或者完成有意义的验证时，应在当次工作结束前更新本文档。** `plan.md` 记录目标架构与实施计划；本文档只记录当前实际状态，不把计划中的能力写成已经完成。

最后更新：2026-08-24

## 当前定位

`thread` 已经是一个可运行的 mini coding-agent harness。它把一个项目视为一个长期 Project Session，并将一个 Thread Version 定义为：

```text
workspace snapshot + conversation context head
```

用户可以在同一个长期 session 中创建 thread branch、恢复历史、比较版本和合并版本，不需要为每个开发任务重新建立会话。项目刻意不复刻完整 Git；没有 staging、rebase、stash 等机制。

当前仍处于早期实现和交互质量完善阶段，不应视为生产稳定版本。

## 已实现

### Harness 核心

- 基于 npm 公开发行的 `@earendil-works/pi-ai` / `@earendil-works/pi-tui`（当前 0.84.2）实现多 provider 模型调用和流式 agent loop；不再依赖本机 pi 源码树。
- 基础工具注册、工具调用/结果处理和多 step 执行；内置 `read`、`list`、`grep`、`write`、`edit`、`bash`、`websearch` 与 `webfetch`。
- `websearch` 通过 Exa 或 Parallel MCP 搜索当前网络信息，默认 Exa，可由 `THREAD_WEBSEARCH_PROVIDER` 切换，并支持可选的 `EXA_API_KEY` / `PARALLEL_API_KEY`。
- `webfetch` 获取 HTTP(S) 文本资源，支持 HTML→Markdown/纯文本转换、超时、5 MiB 响应上限和 200,000 字符模型输出上限；两个网络工具均不自动重放。
- 小型扩展面：事件钩子、工具注册、命令注册与扩展加载。
- 不再设置独立的外部 memory 服务或内置 memory 工具；长期项目知识由版本化 conversation context 中的 compaction 项目状态承载。
- 从启动目录发现并关联 Git workspace。
- 全局 thread 模型配置；未配置 thread 时可回退读取本机 pi 模型配置。
- `/model` 在 TUI 中打开二级模型选择列表，默认只显示活动配置中明确声明的模型并始终补入当前模型；`/model all` 可显式浏览 pi-ai 完整内置及配置目录。支持 ↑/↓ 或 j/k 循环选择、Enter 切换、Esc 取消及长目录窗口化显示；plain/direct 模式可查看当前模型、列出默认选项或指定 provider 的完整模型集合，并用显式参数从完整目录切换。切换会保留现有 workspace/context，同时统一更新主 agent loop、compaction、Capsule、semantic diff/merge 和 TUI 状态。
- GitHub 仓库公开发布并采用 MIT License；英文/简体中文 README 在顶部双向跳转，并在 README 内集中记录 pi、OpenCode、DeepSeek Harness、htmlparser2、Turndown 的依赖/参考关系和 pi 派生代码的 MIT 归属声明。

### Session 与持久化

- 使用 append-only `events.jsonl` 作为 canonical session log，启动时 replay 为内存投影。
- 每个普通 turn 持久化 user entry、assistant/tool entries、turn 状态和内部 checkpoint。
- 普通 turn 有执行前 `turn_base` 和完成后的结果 checkpoint，可恢复到某条历史用户消息执行前。
- `/clear`：只清空当前终端显示，不改变后端上下文或持久化状态。
- `/rewind` 和 `/thread history`：查看并恢复历史消息位置。
- v1 不使用 SQLite；SQLite 留待后续确有索引或并发需求时再评估。

### Thread Version

- 独立于主仓库 refs/index/HEAD 的 Checkpoint DAG 和 Thread BranchRef。
- 每个 checkpoint 同时引用 sidecar workspace tree 与 session context head。
- `/thread branch`、`branches`、`switch`、`status`、`log`、`reflog`、`show`。
- `/thread commit <message>`：无 staging，给当前 checkpoint 创建显式不可变里程碑。
- `/thread restore <ref>`：支持恢复 workspace、context 或两者。
- workspace 通过独立 sidecar Git 对象库捕获、保活、diff 和 materialize，不移动主仓库 Git 状态。

### Context Capsule 与 Thread Diff

- 显式 commit 成功后同步尝试生成 Context Capsule；摘要失败不回滚 commit。
- Capsule 读取该 checkpoint 的动态活跃上下文：最近一次 compaction summary、retained tail，以及之后新增的消息。
- Capsule 不重新展开无限原始 session log，也不包含全局 system prompt 或工具 schema。
- Capsule 输入排除 thinking、usage、`details.raw` 等非必要元数据；文本调用无法表达的图片只保留省略标记。
- Capsule prompt/input 版本为 `capsule-v4`，输出上限为 **3,000 tokens**；提示词明确这是最大值，内容完整后应提前结束，不得为写满额度添加内容。
- `/thread diff A B --facts`：不调用模型，输出公共 checkpoint、workspace 文件变化和 context 结构差异。
- `/thread diff A B`：组合 FROM/TO Capsule、确定性 facts 和预算内代码 patch，通过隔离模型调用生成 `FROM → TO` 的自然语言 diff。
- Semantic diff 优先描述目标、要求、决策、理解、验证和未完成事项的上下文变化，再描述 workspace 变化。
- Diff prompt 版本为 `thread-diff-v2`，输出上限为 **4,000 tokens**；同样明确无需写满。
- Semantic diff 使用派生缓存；结果显示在临时 view，不追加到主会话上下文。模型调用失败时仍返回确定性 facts。

### Thread Merge

- workspace 三方 merge preview。
- v1 只应用 clean merge；有冲突时报告并保持当前 workspace 不变。
- context 支持两种策略：
  - `keep-current`：保留当前分支上下文，不调用模型。
  - `summarize`：使用 common ancestor/current/incoming 三个 Capsule 生成 incoming context handoff note。
- merge preview 和摘要草稿在确认前不修改 workspace、branch ref 或 session head。
- clean merge 创建双 parent checkpoint，并创建显式 Thread Commit。

### 上下文压缩

- 自动压缩与 `/compact` 使用同一套 compaction 算法。
- 自动触发依据完整请求预算：system prompt、tools、extension context、消息、输出预算和安全余量。
- compaction 与 Context Capsule 共用确定性的语义消息投影：保留每条消息的 `YYYY-MM-DD` 来源日期、用户可见文本、tool call、模型可见 tool result 和材料性停止/错误状态，排除 provider 元数据、usage、thinking、签名、图片二进制和 `details.raw`。
- 项目状态同时承担选择性长期记忆、当前项目状态和近期已压缩会话摘要三种职责；长期记忆只保留可能帮助未来工作的稳定信息，近期摘要会记录用户最近讨论或要求的内容，但不扩张成逐轮 transcript。
- 首次压缩从较早交互创建项目状态；后续压缩显式使用“上一版项目状态 + 新增交互”生成完整更新状态，重新判断旧记忆的有效性和未来价值，使用较新纠正覆盖旧状态，舍弃过时或无后续价值的条目，并替换而非累积近期会话摘要。
- 时间敏感的要求、决策、期限、临时条件、版本假设和被覆盖事实可在项目状态中保留来源绝对日期；永恒事实不机械添加日期。
- 压缩后的 input context 目标为模型窗口的 **7%**，不是破坏交互边界的硬限制。
- 在预算内自适应保留尽可能多的近期完整 user-led interactions，最少保留两轮；短交互保留更多，大 tool result 会减少保留轮数。
- 只摘要更早的前缀，不切断 tool call/result 关系；原始 session entries 仍然保留。
- continuation project state 上限为 4,000 tokens。
- 单次请求容纳不下新增交互时，按时间分块生成最多 1,536 tokens 的中间摘要，再递归归并后应用到上一版项目状态。
- compaction prompt 将输出定义为可继续工作的版本化项目状态，保留材料性结论与证据，不复制 read/search 原文、长日志或命令流水账。
- `/compact` 不作为用户消息发给主模型；成功后创建可恢复的内部 command checkpoint，但不创建 Thread Commit。

### 终端界面

- 基于 `@earendil-works/pi-tui` 的 fullscreen TUI，并保留 plain 输出适配器。
- 支持 Markdown、代码块、表格和语义配色；流式显示 agent 回复和工具状态。
- 固定 header、editor、status/footer，以及 conversation viewport。
- diff、merge、history 使用不污染主 session 的临时 view。
- 支持 `/model`、`/clear`、`/compact` 和 `/thread` 命令补全/路由。

## 当前已知限制

- 7% 是执行压缩后的目标，不是活跃上下文始终保持的上限。若在上下文已接近模型窗口时 commit，完整 Capsule 调用仍可能溢出；commit 会保留，但 Capsule 会标记失败。目前 Capsule 尚未复用 compaction 的分块归并。
- Capsule 是有损语义缓存，不属于 checkpoint 身份；raw session entries 和 workspace tree 才是事实源。
- Semantic diff 的 context 确定性事实目前主要是 ancestry、entry 范围和数量；具体语义变化主要依赖 Capsule。
- 输入中的图片目前不能由文本型 Capsule 调用完整继承。
- workspace merge 没有交互式冲突编辑器，也没有 `merge --continue/--abort` 状态机。
- context merge 目前只有 `keep-current` 和 `summarize`，不尝试拼接两条原始对话树。
- 内置 coding tools、权限策略和扩展生态仍较小；网络工具没有专用审批层。
- `webfetch` 尚未阻止私网、loopback、link-local 或 DNS 重绑定目标，在可访问敏感内网服务的部署中存在 SSRF 风险；当前只拒绝非 HTTP(S)、URL 内嵌凭据和二进制响应。
- `/model` 只切换当前进程，不写回全局配置；重启后仍按 CLI、环境变量和配置文件的优先级选择默认模型。
- 尚未引入 SQLite、后台任务队列或多进程并发写入。

## 最近完成

- 收紧 `/model` picker：默认从 1,000 余项 pi-ai 全量目录缩减为配置模型及当前模型，完整目录改由显式 `/model all` 打开；provider 定向列出和直接切换仍可访问完整目录。
- 调整主 Agent 默认 system prompt：明确其名称为 `thread`，移除无实际作用的命令路由说明，并要求总结或汇报时在不删减有效信息的前提下降低表达密度，通过必要铺垫、自然过渡和循序展开做到深入浅出。
- 移除 `/new` 及其空上下文 checkpoint 路径，Project Session 不再提供主动失忆入口，长期上下文统一由 compaction 管理。
- 将仓库改为公开 MIT 项目，补充完整简体中文 README、双向语言入口和带超链接的外部项目/第三方许可说明；不额外拆分 attribution 文档。
- 增加 `/model` 运行时模型切换和 TUI 二级模型 picker：从斜杠补全回车后直接进入可上下选择的模型列表；切换时原子替换对话、压缩及版本语义服务所用模型，并动态刷新 TUI 模型标签和上下文占比。
- 参考 OpenCode 增加 `websearch` / `webfetch`：复用 Exa/Parallel MCP 搜索协议，实现可取消、限时、限长的 HTTP 抓取、HTML→Markdown/纯文本转换，并将网络请求标记为不可自动重放。
- 将 Thread Version 命令空间统一为 `/thread`，同步路由边界、帮助与 usage、TUI 补全和状态提示、扩展命令、测试、文档及概念图。
- 项目全面统一为 `thread` 品牌：CLI、npm package、公开 TypeScript API、配置目录与环境变量、sidecar 持久化路径、UI 文案、测试和文档使用同一名称。
- 移除独立外部 memory 系统：删除 MemoryService、检索投影、system prompt 注入以及 `memory_write` / `memory_search` / `memory_archive` 内置工具；旧日志中的 `memory_changed` 事件只为兼容读取而忽略，不再恢复为运行时状态。
- 优化 compaction 项目状态提示词：选择性维护长期记忆、按新证据和日期淘汰过时状态，并保留滚动的近期会话摘要；语义投影为消息提供天级绝对日期。
- 将 compaction 从重复生成自由摘要改为增量项目状态更新，并与 Context Capsule 共用去除 thinking、usage、raw details 等噪声的语义消息投影。
- 将 `@earendil-works/pi-ai` / `@earendil-works/pi-tui` 依赖从本机 pi 源码树切换为 npm 公开发行的 0.84.2，删除 `.npmrc` 和 `scripts/check-pi-ai.mjs`。
- 由于发布版 0.84.2 的根入口尚未导出 `estimateContextTokens`（本地 pi 源码领先发布版约 44 个提交），将其实现 vendor 到 `src/utils/estimate.ts`，与本地 pi 源码保持逐行一致；待上游发布后应改回从 pi-ai 导入并删除 vendor 文件。
- 改进终端 Markdown 渲染和对话布局。
- 增加 `/clear` 与 `/compact`。
- 将 compaction 改为 7% 目标下的自适应完整交互保留，并支持超长前缀分块归并。
- 收紧 compaction prompt：工具结果只保留材料性结论，不记录命令清单或原始长输出。
- 将 Context Capsule 改为直接读取 checkpoint 的动态活跃上下文，移除固定 `120,000` 字符尾部截断。
- 将 Capsule/Diff prompt 升级到 v2：明确方向、证据优先级、上下文优先级、事实与推断边界以及最大输出额度。
- Capsule 最大输出调整为 3,000 tokens；semantic diff 最大输出调整为 4,000 tokens。

## 验证状态

- `/new` 的运行时路由、空上下文 checkpoint API、TUI 补全、CLI help 及中英文 README 已移除；源码和用户文档仅在本进度记录的移除说明中保留该名称。
- `npm run check`、`npm run build` 通过，全部 14 个测试（phase0 + smoke）通过；`/model` 回归测试覆盖配置目录过滤、完整目录入口、当前模型补入、picker 视图、当前模型定位、循环选择、provider 定向目录、两种直接切换语法、含 `/` 的模型 ID、主循环和语义服务同步替换及无目录的注入模型边界；网络工具测试覆盖注册、provider 选择、JSON/SSE MCP 结果、Exa 请求、HTML 转换和响应上限；compaction 回归测试只验证语义投影和增量状态更新机制，不评价模型摘要质量；session log 恢复测试同时确认旧版 `memory_changed` 事件可读取但不会恢复记忆投影。
- 使用当前本机 pi 配置进行目录 smoke：默认 picker 精确列出 6 个配置模型，`/model all` 仍可访问包含这些配置项在内的 1,273 项完整目录；验证过程只输出模型标识和数量，不读取或打印凭据。
- 无密钥真实网络 smoke 通过：Exa MCP `web_search_exa` 能返回 Node.js 官方站点结果，`webfetch` 能获取并提取 `https://example.com` 的文本。
- `thread` 更名通过全仓旧名称零匹配扫描；`thread --help` 文案和 `ThreadApp` / `ThreadTerminalApp` / `THREAD_VERSION` 等构建产物公开导出已验证。
- `/thread` 命令空间通过旧命令字符串零匹配扫描和构建产物路由检查；`/thread` 可列出并执行命令，旧前缀不再被命令路由器接收。
- MIT `LICENSE` 与 npm package metadata 一致；英文/中文 README 均为 13 个对应正文 section，双向入口和全部相对链接可解析，pi/OpenCode/DeepSeek Harness 的外部源码链接已按实际分支核验。
- 按项目约定只做与变更风险相称的必要检查，不进行大范围或重复测试。

## 建议的下一步

1. 在真实长会话中交互验证 `/thread commit` → `/thread diff` 的 Capsule 和自然语言 diff 质量。
2. 根据真实溢出情况决定是否让 Capsule 复用 compaction 的分块归并，而不是预先增加复杂度。
3. 继续完善 diff/merge 临时 view 的信息层级、滚动和确认体验。
4. 为 `webfetch` 增加 DNS 解析后的私网/loopback/link-local 拦截和逐跳 redirect 校验，再评估 web 专用审批策略。
