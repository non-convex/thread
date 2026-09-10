# 嵌入 Thread runtime

`thread/runtime` 提供 Bun 进程内的公共入口，适合由其他 AI 应用、GUI 或 Web 后端持有。统一通过 `ThreadRuntime.open()` 配置 agent loop、工具、Skill 和持久化 Session Tree；基础工具和文件 checkpoint 按需启用。Web 前端通过自己的后端适配器调用这个入口；runtime 本身没有 HTTP 服务。

## 源码与依赖边界

公共入口保持在 `src/runtime.ts`，实现统一放在 `src/core/`。其中 `runtime/` 负责配置、装配和生命周期，`agent/`、`tools/`、`skills/`、会话与记忆等子目录按能力组织。宿主从 `thread/runtime` 导入，无需依赖内部路径。

`src/app/` 持有 coding 默认提示词、命令、应用扩展、配置文件加载与用户选择的保存；`src/cli/` 和 `src/ui/` 负责启动和展示。核心保留模型配置类型、状态回调的数据结构及共用能力，不能导入应用代码，类型依赖也遵守同一方向。

`scripts/verify-runtime.ts` 检查整个 `src/core/`（包括 worker 和原生资源入口）的依赖方向，以及构建后的 runtime 不加载 TUI。仓库仍是一个包，公开入口为 `thread`、`thread/runtime` 和 `thread/tui`；本次目录分层不改变安装依赖，也不增加独立发布流程。MCP 实现后同样归入核心。

## 运行离线示例

在仓库根目录执行：

```sh
bun run build
bun examples/runtime.ts
```

[完整示例](../examples/runtime.ts) 从构建后的 `thread/runtime` 导入，声明内置 `read` 工具、自定义 `add` 工具和 `./skills` 加载路径。脚本模型依次调用 `skill`、`read`、`add`，输出 `The answer is 42.`，不需要 API key。它创建独立的临时工作区和数据目录，运行后关闭 runtime 并清理目录。

`bun run test:runtime` 另外在独立宿主目录验证包导出，并检查导入不会加载终端前端或写入默认 `THREAD_HOME`。

## 创建与执行

```ts
import { ThreadRuntime, type ModelClient, type AgentTool } from "thread/runtime";

async function answer(model: ModelClient, customTool: AgentTool) {
  const runtime = await ThreadRuntime.open({
    rootPath: "/path/to/workspace",
    stateDirectory: "/path/to/application-data/thread",
    model,
    tools: ["read", "bash", "websearch", "webfetch", customTool],
    systemPrompt: "Use the capabilities provided by this application.",
    skills: { paths: ["./skills", "/path/to/shared-skills"] },
    fileCheckpoints: false,
  });
  try {
    const session = await runtime.createSession();
    const dispose = runtime.subscribe((event) => {
      if (event.sessionId === session.id && event.type === "assistant_text_delta") {
        process.stdout.write(event.delta);
      }
    });
    try {
      return await runtime.prompt(session.id, "Hello", { maxSteps: 20, timeoutMs: 120_000 });
    } finally {
      dispose();
    }
  } finally {
    await runtime.close();
  }
}
```

默认 `tools` 为空，不扫描 Skill 目录，不启用文件 checkpoint；会话记录仍然落盘。数据目录直接传给实例，宿主无需修改进程级 `THREAD_HOME`；省略 `stateDirectory` 才使用 Thread 的默认项目数据目录。`rootPath` 仍须指向存在的本地项目目录。

coding 应用的默认配置统一由 `ThreadApp.open()` 装配：完整基础工具、默认 Skill 目录、产品提示词、Recall、全局记忆和文件 checkpoint。CLI 和直接使用 coding 应用的调用者共享这份配置；`ThreadRuntime.open()` 的最小默认值保持独立。

`ThreadApp` 持有公开的 `runtime`，负责斜杠命令、菜单及选中的会话。执行、查询、配置和事件通过 `app.runtime` 访问，没有继承或一组重复的转发方法。应用扩展同样经过 runtime 的工具注册和执行边界；命令通过 `context.runtime` 查询历史，使用 `context.openSession()` 选择会话，不再直接访问可写的 Session Tree。

```ts
import { ThreadApp } from "thread";

const app = await ThreadApp.open({ rootPath, model });
try {
  await app.handleInput("Inspect this project", { signal });
  const history = app.runtime.readSession(app.selectedSessionId);
} finally {
  await app.close();
}
```

`ThreadApp` 可通过 `search: false` 或 `globalMemoryPath: false` 关闭相应产品能力；其他 AI 宿主使用 `ThreadRuntime.open()` 声明自己的能力。coding 应用在 plain 模式仍暴露 `ask`，缺少交互展示时返回原有的不可用结果；TUI 为同一个工具绑定问题面板。

coding 应用默认在启动时读取 `rootPath/AGENTS.md`，将项目指令共享给主 agent 和 implementation worker；`projectInstructions: false` 可关闭读取。只读取根目录这一份文件，不遍历祖先、子目录或全局指令目录。缺失或空文件不追加内容；文件须为项目内的 UTF-8 普通文件，上限 32 KiB，超限或无法读取时报错，不截断规则。修改文件后重新打开应用才会生效，同一实例内新建会话或重新启用 worker 仍使用启动快照。

创建实例时会复制配置数据。之后修改原始 options 中的提示词、工具定义、Skill 路径、已加载 Skill 或 worker 限制，不会悄悄重配正在使用的实例；明确的模型切换使用 `setModel()` 等操作。工具的执行函数仍绑定宿主提供的原始实例，支持带内部状态的类实现。注入的模型客户端、工具资源、交互服务及嵌入客户端仍由宿主负责其生命周期；关闭 runtime 不会关闭共享模型客户端。

`prompt()` 将输入当作模型输入，例如 `"/new"` 会原样进入会话。创建会话使用 `createSession()`；斜杠命令、picker 和输入框属于客户端。

## 选择工具与加载 Skill

`tools` 接受内置工具名称与 `AgentTool` 对象混合配置。内置名称为 `read`、`list`、`grep`、`write`、`edit`、`bash`、`websearch`、`webfetch`；没有声明的基础工具不会自动启用。未知名称或重复名称会报错，不覆盖已有工具。工具保留现有运行要求，例如 `grep` 需要 `rg`，网络工具使用现有的网络访问与搜索提供方配置。

自定义工具实现公共 `AgentTool` 接口，提供名称、描述、参数 schema、执行策略和 `execute()`；可在创建时传入，或空闲时通过 `runtime.registerTool(tool)` 添加。内置工具和自定义工具使用同一参数校验、调度、宿主策略、取消信号和执行记录。可运行的自定义工具见离线示例中的 `add`。

需要解析别名、默认路径或游标的工具可实现 `prepare(args, context)`。执行顺序为：schema 校验 → 扩展改写与再次校验 → `prepare()` → 资源声明 → 宿主授权 → 调度与执行。`prepare()` 每次调用只运行一次，收到取消信号，只能进行参数和目标解析，不能执行工具的业务副作用。省略时沿用校验后的参数；`AgentTool<Input, Prepared>` 可声明与模型输入不同的有效参数类型。资源声明、授权、执行与 `effectiveArgs` 记录均使用准备后的参数，模型的原始 tool call 仍保留在助手消息中。

内置文件工具在准备阶段统一处理路径空白和链接别名；普通相对路径的展示保持不变。`grep` 把游标中的搜索条件和分页位置展开为有效参数，宿主无需解码私有游标。文件访问前仍检查实际路径是否落在批准的资源范围，写入排队后再次检查；这些检查不构成针对任意脚本或自定义工具的操作系统沙箱。

`skills: { paths: [...] }` 只在启动时扫描声明的目录。相对路径以 `rootPath` 为基准，多个目录按声明顺序加载；同一文件去重，同名 Skill 保留先声明项并报告诊断。runtime 不自动扫描 `${THREAD_HOME}/skills` 或其他全局路径。宿主也可传入已加载的 `LoadedSkills`，形如 `{ skills, diagnostics }`。

有可供模型调用的 Skill 时，runtime 自动加入 `skill` 工具；无需在 `tools` 中重复声明。系统提示词只包含这些 Skill 的目录和加载说明，正文由工具按需返回。带 `disable-model-invocation: true` 的 Skill 不进入模型目录，也不能由模型的 `skill` 工具加载；宿主仍可使用 `invokeSkill()` 显式调用。`runtime.skills` 和 `runtime.skillDiagnostics` 返回独立副本。

宿主的 `systemPrompt` 保留原文，`appendSystemPrompt` 用于主 agent 的追加指令；`sharedInstructions` 用于主 agent 和 implementation worker 共用的指令。worker 保留自己的角色提示词，不继承主 agent 的角色；Dreamer 也不继承项目执行指令。核心不查找 `AGENTS.md`，嵌入宿主可自行读取指令并传入 `sharedInstructions`。

加载 Skill 后会追加对应能力说明，核心不会自动加入 coding 角色、文件编辑约定或 Git 提交署名。显式启用 `search`（会话 Recall）、`globalMemoryPath`、交互或 worker 时，还会装配这些能力对应的工具或说明；`search` 与基础工具 `websearch` 是不同功能。

MCP 属于未来的核心能力，将通过同一工具注册、策略、执行与取消机制接入。当前尚未实现 MCP 客户端或配置项。

## 文件 checkpoint 与会话回退

`fileCheckpoints` 默认 `false`。关闭时，内置 `write` 和 `edit` 仍可工作，但不保存文件备份或追加 `file_edit` 记录；路径检查、取消处理、主 agent 与 worker 的同路径写入协调仍然生效。Session Tree 的会话和工具执行记录继续持久化，因此关闭文件 checkpoint 不等于使用内存会话。

worker 的内置 `write` 和 `edit` 在共享写入入口校验任务的 `writeScope`，拒绝修改范围外的实际路径；检查发生在文件备份和修改之前，进入同路径写入队列后再次确认目标。文件范围只允许该文件，目录范围允许其后代，符号链接不能扩大范围；返工沿用原任务范围。宿主策略放行不会跳过这项检查。它不限制任意 bash 命令或自定义工具的文件副作用，也不是操作系统沙箱。详见 [Subagent 架构](./subagent-architecture.md)。

开启 `fileCheckpoints: true` 后，内置文件编辑工具会保存每轮首次修改前的文件内容。worker 的记录归属于主 agent 的父 turn；bash、脚本和自定义工具的任意文件修改不会因此自动获得 checkpoint。

```ts
// 默认行为跟随创建实例时的 fileCheckpoints。
await runtime.rewind(sessionId, turnId);

// 只回退会话 live tip，保留当前文件内容。
await runtime.rewind(sessionId, turnId, { restoreFiles: false });

// 恢复记录的文件修改并回退会话，需要启用 fileCheckpoints。
await runtime.rewind(sessionId, turnId, { restoreFiles: true });
```

选定 turn 及其后的 turn 留在历史中，live tip 移到选定 turn 的父节点。仅会话回退不会清理已有文件备份；文件内容可能与回退后的上下文不同，由宿主决定是否需要恢复。

关闭 checkpoint 时显式请求 `restoreFiles: true` 会报错。每轮记录其 checkpoint 启用状态；旧 turn 缺失该字段时按开启解释。重新打开同一数据目录并切换配置后，文件恢复若跨越关闭 checkpoint 的轮次，会在修改文件或移动 live tip 前拒绝，避免使用不完整记录。所需备份缺失或损坏同样会在恢复前报错。文件恢复沿用原有语义：覆盖记录的路径，不检查这些路径后来是否被手动或 bash 修改。

## 会话与读取

每次执行都显式传入 `sessionId`。客户端分别保存自己选中的会话，即使另一个客户端创建或读取会话，也不会改变本次执行的目标。一个 runtime 同时只运行一个前台操作，忙时拒绝新的执行；当前版本不提供同项目跨会话并发。

| 操作 | 语义 |
| --- | --- |
| `createSession()` | 创建并返回 `ProjectSession` |
| `listSessions()` | 返回会话 ID、live tip、turn 数和创建时间 |
| `readSession(sessionId)` | 返回会话、已提交 live path 上的 `turns`、`entries`、`tasks`、`liveTipTurnId`，以及独立的 `activeTurn` |
| `readHistory()` | 返回整个项目保留的会话、turn、条目和 live tips，包含回退后保留的分支 |
| `prompt(sessionId, input, options?)` | 执行并返回 `TurnResult`，包含 turn、结果和模型消息 |
| `setModel(model)` / `setThinkingLevel(level)` | 模型在空闲时切换；思考偏好可以随时调整，从下一轮生效 |
| `openSession(sessionId)` | 保存下次启动应恢复的会话，不改变显式 prompt 的目标 |
| `searchHistory(queries, options?)` | 查询已启用的 Recall，支持 limit 和取消信号 |
| `compact(sessionId)` / `rewind(sessionId, target, options?)` | 压缩目标会话上下文，或回退 live tip；是否恢复文件由 `restoreFiles` 决定 |
| `interrupt(sessionId)` | 取消指定会话的当前执行，并等待结算；不会取消其他会话 |
| `subscribe(listener)` | 订阅实时执行事件，返回取消订阅函数 |
| `close()` | 停止接收操作、取消并等待执行、关闭实例拥有的资源 |

Session Tree 的历史与传给模型的上下文分别保存。读取快照不会改变内部状态；客户端不应通过修改快照来编辑历史。进程恢复时保留未完成任务的记录并将其结算为 interrupted，不自动重跑结果不确定的工具。

`activeTurn` 为 `{ turn, entries, tasks }` 或 `null`，包含目标会话正在运行的一轮及其已记录的输入、助手内容、工具调用和结果。它与顶层已提交的历史分开；完成、中断或失败后，该轮进入 live path，`activeTurn` 变为 `null`，不重复返回。运行中查询通过会话索引定位这一轮，不需要复制其他会话的历史。未形成记录的流式增量不在此快照中，刷新后继续通过 `subscribe()` 接收进度。

Session Tree 通过 `fs-native-extensions` 使用操作系统文件锁保护整个 runtime 的持久化写入。正常关闭或进程退出会释放锁；`session-tree.lock` 文件保留，文件存在或其中的旧 PID 文本不代表被占用，也不要通过删除它解锁。升级到该锁协议前须先退出使用同一数据目录的旧版进程；旧版只识别 PID 文件，不应与新版同时运行。旧锁文件可以直接复用，无需清理；会话日志格式不变。

每轮开始时创建执行器，捕获该轮的模型、思考级别和系统提示词。执行中通过 `setThinkingLevel()` 或 TUI 的 `Shift+Tab` 调整偏好，不改变当前轮后续模型步骤；下一轮使用新设置。

主回合先完成 turn 持久化，再运行扩展和模型；所有模型步骤都通过同一个上下文构建器读取已落盘的 turn。工具执行记录仍须在相应工具产生副作用前落盘，写入类工具继续等待完整 assistant 消息持久化。

## 取消、完成与预算

`prompt()` 返回时，当前 turn 的工具收尾、历史结算和必要持久化已结束。结果的 `outcome` 区分 `completed`、`interrupted` 和 `failed`。调用参数无效、目标不存在、实例已关闭等请求错误会拒绝 Promise。

`interrupt()` 和 `close()` 都是完成屏障。重复 `close()` 返回同一个 Promise；开始关闭后拒绝新的操作。宿主应在退出时等待这个 Promise，不要仅通知取消就释放进程。

取消是协作式的。模型和自定义工具收到的 `signal` 必须传给底层 I/O，并在取消后完成资源清理。runtime 会等待它们结算；超时不会强杀任意进程内 JavaScript。

`maxSteps` 限制一次用户请求中的模型步骤数，包括上下文溢出后的恢复步骤；传输重试不另算步骤。`timeoutMs` 到期请求取消。限制触发后，结果中的 `limit` 标明 `maxSteps` 或 `timeout`。也可以传入宿主的 `AbortSignal`，或由停止按钮调用 `interrupt(sessionId)`。如果任务需要在浏览器断线后继续执行，应由后端持有 runtime，避免把任务的 signal 绑定到浏览器请求寿命。

## 事件和扩展

`RuntimeEvent` 携带 `sessionId` 和 `turnId`；会话创建或回退到 Root 的 `session_changed` 事件允许 `turnId` 为 `null`。模型输出带 `entryId`，工具事件带 `toolCallId`。同步或异步观察者异常不改变任务结果；runtime 不等待异步观察者，取消订阅也不会取消任务。客户端可合并文本增量，状态快照从公共查询方法读取。

流式增量是临时进度，订阅不是持久化事件重放接口。`turn_started` 和 `turn_finished` 在相应持久化屏障后发布。需要网络重连时，适配层应协调状态快照和后续事件之间的衔接。

宿主工具策略与普通观察者分开。策略收到准备后的 `args` 和已解析的 `resources`，可按资源的 `namespace`、`resource`、`access`、`scope` 判断权限。主 agent、worker 和后台 agent 均使用该策略；拒绝后的调用不会执行。传给策略和资源声明函数的数据是副本，修改它们不会改写后续执行。自定义工具必须如实声明其资源；策略回调不等同于进程沙箱。

通过 `askPresenter` 提供交互能力，可以传入公共入口导出的 `AskService`，或实现自己的 `AskPresenter`。工具发起的 `AskRequest.invocation` 标明 session、turn、tool call 和 agent 身份。取消或关闭 runtime 会取消它正在等待的问题，并等待 turn 结算；宿主传入的 `AskService` 仍由宿主负责 `dispose()`，可被其他客户端继续使用。

当前版本继续使用本地 Session Tree 存储和 Bun，不引入服务器、远程文件系统、通用存储接口或分布式执行。第二个真实宿主需要这些能力时，再增添对应适配器。
