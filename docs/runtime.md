# 嵌入 Thread runtime

`thread/runtime` 提供 Bun 进程内的公共入口，适合由其他 AI 应用、GUI 或 Web 后端持有。统一通过 `ThreadRuntime.open()` 配置 agent loop、工具、Skill 和持久化 Session Tree；基础工具和文件 checkpoint 按需启用。Web 前端通过自己的后端适配器调用这个入口；runtime 本身没有 HTTP 服务。

## 源码与依赖边界

公共入口保持在 `src/runtime.ts`，实现统一放在 `src/core/`。其中 `runtime/` 负责配置、装配和生命周期，`agent/`、`tools/`、`skills/`、会话与记忆等子目录按能力组织。宿主从 `thread/runtime` 导入，无需依赖内部路径。

`src/app/` 持有 coding 默认提示词、命令、应用扩展、配置文件加载与用户选择的保存；`src/cli/` 和 `src/ui/` 负责启动和展示。核心保留模型配置类型、状态回调的数据结构及共用能力，不能导入应用代码，类型依赖也遵守同一方向。

仓库是一个包，公开入口为 `thread`、`thread/runtime` 和 `thread/tui`，共用安装依赖与发布流程。MCP 实现后同样归入核心。

## 运行离线示例

在仓库根目录执行：

```sh
bun run build
bun examples/runtime.ts
```

[完整示例](../examples/runtime.ts) 从构建后的 `thread/runtime` 导入，声明内置 `read` 工具、自定义 `add` 工具和 `./skills` 加载路径。脚本模型依次调用 `skill`、`read`、`add`，输出 `The answer is 42.`，不需要 API key。它创建独立的临时工作区和数据目录，运行后关闭 runtime 并清理目录。

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

coding 应用默认在启动时读取 `rootPath/AGENTS.md`，将项目指令共享给主 agent 和 worker；`projectInstructions: false` 可关闭读取。只读取根目录这一份文件，不遍历祖先、子目录或全局指令目录。缺失或空文件不追加内容；文件须为项目内的 UTF-8 普通文件，上限 32 KiB，超限或无法读取时报错，不截断规则。修改文件后重新打开应用才会生效，同一实例内新建会话或重新启用 worker 仍使用启动快照。

创建实例时会复制配置数据。之后修改原始 options 中的提示词、工具定义、Skill 路径、已加载 Skill 或 worker 限制，不会悄悄重配正在使用的实例；明确的模型切换使用 `setModel()` 等操作。工具的执行函数仍绑定宿主提供的原始实例，支持带内部状态的类实现。注入的模型客户端、工具资源、交互服务及嵌入客户端仍由宿主负责其生命周期；关闭 runtime 不会关闭共享模型客户端。

`prompt()` 将输入当作模型输入，例如 `"/new"` 会原样进入会话。创建会话使用 `createSession()`；斜杠命令、picker 和输入框属于客户端。

## 选择工具与加载 Skill

`tools` 接受内置工具名称与 `AgentTool` 对象混合配置。内置名称为 `read`、`view_image`、`list`、`grep`、`write`、`edit`、`bash`、`websearch`、`webfetch`；没有声明的基础工具不会自动启用。未知名称或重复名称会报错，不覆盖已有工具。工具保留现有运行要求，例如 `grep` 需要 `rg`，网络工具使用现有的网络访问与搜索提供方配置。

为减少工具结果进入 live context 的体积，几个常用工具默认返回有限内容：

| 工具 | 默认输出与继续读取 |
| --- | --- |
| `read` | 2,000 行，仍受 64 KiB 上限约束；按需使用 `offset/limit` 读取相关范围 |
| `view_image` | 读取本地图片并把实际像素作为图片块回传模型；默认最长边 1568 像素，`detail: "original"` 保留原始尺寸；输入和输出各最多 8 MiB，最多 2000 万像素 |
| `webfetch` | 32,000 字符；使用返回的 `nextOffset` 继续，或显式指定 `limit`（单页最多 200,000）。偏移按转换后的文本计算，使用 UTF-16 索引且不会切断代理对；每次调用重新抓取，动态页面内容可能变化 |
| `bash` | stdout、stderr 各显示最多 16 KiB 尾部；较长的已捕获输出保存到系统临时目录，结果给出绝对路径，可用 `read` 或已有的 `bash` 搜索、分段读取，无需重跑原命令 |

`bash` 的捕获范围仍是每个流最后 64 KiB，超过部分已丢弃，结果和保存文件都会明确说明。输出文件与文件 checkpoint、Recall 无关，Thread 不主动删除，系统清理临时目录后可能不可用；保存失败时直接返回已捕获内容，保留命令原本的成功或失败状态。

`bash` 只等待前台命令，不提供后台进程管理。Windows 上，有些命令启动的后台服务会继承输出管道，导致前台已经退出、管道却一直不关闭。Thread 在前台退出后最多再收集 500 毫秒输出；管道正常关闭时会立即返回。

取消或超时会尝试终止进程树，最多再等 1 秒就结束调用，不以所有后代进程都已退出为保证。如果提前结束了输出捕获，结果和保存文件会提示末尾输出可能缺失；延后写入的后台进程也可能遇到管道已关闭的错误。

自定义工具实现公共 `AgentTool` 接口，提供名称、描述、参数 schema、执行策略和 `execute()`；可在创建时传入，或空闲时通过 `runtime.registerTool(tool)` 添加。内置工具和自定义工具使用同一参数校验、调度、宿主策略、取消信号和执行记录。可运行的自定义工具见离线示例中的 `add`。

`view_image({ path, detail? })` 支持 PNG、JPEG、WebP、GIF、BMP；按文件内容识别格式并解码，动图只使用首帧。文件路径可以相对项目，也可以是项目外的绝对路径，沿用 `read` 的资源声明、宿主授权和路径复查。编码与 TUI 粘贴图片共享 `core/images/prepare.ts`，需要支持 `Bun.Image` 的运行时。CLI 和 Worker 默认注册此工具；嵌入宿主通过 `tools: ["view_image"]` 显式启用。当前模型必须声明 `acceptsImages: true`（自定义模型配置为 `input: ["text", "image"]`），否则工具明确返回错误，不声称已经看过图片。`original` 控制本地预处理，服务商仍可能按自身规则处理图片。

`ToolResult.content` 是文本说明；可选的 `images: ImageContent[]` 保存 `{ type: "image", mimeType, data }`，其中 `data` 是 base64 图片字节。执行器把两者合成模型可见的工具结果，像素随消息持久化并参与后续请求，`details.raw` 不重复保存图片字节。`ToolContext.acceptsImages` 表示当前执行模型的能力。`tool_result` 扩展可分别改写 `modelContent` 和 `modelImages`，设 `modelImages: []` 可移除附件。普通工具事件与终端只展示文本、尺寸和格式，不展示 base64；切换纯文本模型时，历史图片在请求中替换为提示，持久化图片保留。

需要解析别名、默认路径或游标的工具可实现 `prepare(args, context)`。执行顺序为：schema 校验 → 扩展改写与再次校验 → `prepare()` → 资源声明 → 宿主授权 → 调度与执行。`prepare()` 每次调用只运行一次，收到取消信号，只能进行参数和目标解析，不能执行工具的业务副作用。省略时沿用校验后的参数；`AgentTool<Input, Prepared>` 可声明与模型输入不同的有效参数类型。资源声明、授权、执行与 `effectiveArgs` 记录均使用准备后的参数，模型的原始 tool call 仍保留在助手消息中。

内置文件工具在准备阶段统一处理路径空白和链接别名；普通相对路径的展示保持不变。`grep` 把游标中的搜索条件和分页位置展开为有效参数，宿主无需解码私有游标。文件访问前仍检查实际路径是否落在批准的资源范围，写入排队后再次检查；这些检查不构成针对任意脚本或自定义工具的操作系统沙箱。

`write`、`edit` 默认只允许修改项目内的文件。宿主可用 `writableExternalPaths` 授权主 agent 写入指定外部文件，或用 `writableExternalDirectories` 授权指定外部目录及其子目录，包括尚未创建的目录；两者的相对路径都以进程当前目录为基准。目录授权按真实路径检查，不能通过目录内的符号链接写到授权边界外，文件本身是符号链接时仍拒绝写入。宿主的 `toolPolicy` 继续生效，Worker 仍受项目内的任务 `writeScope` 限制。

`skills: { paths: [...] }` 只在启动时扫描声明的目录。相对路径以 `rootPath` 为基准，多个目录按声明顺序加载；同一文件去重，同名 Skill 保留先声明项并报告诊断。runtime 不自动扫描 `${THREAD_HOME}/skills` 或其他全局路径。宿主也可传入已加载的 `LoadedSkills`，形如 `{ skills, diagnostics }`。

CLI 和 `ThreadApp` 自动把配置的 Skill 扫描目录加入可写目录，默认是 `${THREAD_HOME}/skills`（未设置 `THREAD_HOME` 时为 `~/.thread/skills`）。主 agent 可用内置 `edit`、`write` 修改其中的 `SKILL.md`、脚本和参考文件，也可以创建新 Skill。裸 `ThreadRuntime` 的 Skill 加载配置不授予写权限，外部目录需显式传入 `writableExternalDirectories`。Skill 仍在启动时加载，修改后重新打开应用才会更新已加载的内容。

有可供模型调用的 Skill 时，runtime 自动加入 `skill` 工具；无需在 `tools` 中重复声明。系统提示词只包含这些 Skill 的目录和加载说明，正文由工具按需返回。带 `disable-model-invocation: true` 的 Skill 不进入模型目录，也不能由模型的 `skill` 工具加载；宿主仍可使用 `invokeSkill()` 显式调用。`runtime.skills` 和 `runtime.skillDiagnostics` 返回独立副本。

宿主的 `systemPrompt` 保留原文，`appendSystemPrompt` 用于主 agent 的追加指令；`sharedInstructions` 用于主 agent 和 worker 共用的指令。worker 保留自己的角色提示词，不继承主 agent 的角色；Dreamer 也不继承项目执行指令。核心不查找 `AGENTS.md`，嵌入宿主可自行读取指令并传入 `sharedInstructions`。

加载 Skill 后会追加对应能力说明，核心不会自动加入 coding 角色、文件编辑约定或 Git 提交署名。显式启用 `search`（会话 Recall）、`globalMemoryPath`、交互或 worker 时，还会装配这些能力对应的工具或说明；`search` 与基础工具 `websearch` 是不同功能。

配置 `globalMemoryPath` 后，Main 使用内置 `read`、`write`、`edit` 管理该文件时，修改必须基于较早模型步骤中的读取；文件被其他 Main 回合或 Dreamer 更新后，旧修改会被拒绝，需要重新读取并生成更新。Dreamer 的内置文件工具只能访问这个文件。读写协调限于同一进程，不覆盖 Bash、自定义文件写入或外部进程，具体边界见[全局记忆与 Dreamer](./global-memory-architecture.md#写入边界)。

MCP 属于未来的核心能力，将通过同一工具注册、策略、执行与取消机制接入。当前尚未实现 MCP 客户端或配置项。

通过 `worker: { enabled: true, model: workerModel }` 启用 Worker；`runtime.workerEnabled` 和 `runtime.workerModel` 查询状态，空闲时用 `runtime.configureAgent("worker", enabled, workerModel)` 调整配置。只接受当前的 `worker` 名称。执行边界见 [Worker 架构](./worker-architecture.md)。

## 内置文件编辑

`edit` 只编辑已有的 UTF-8 文件，参数统一为 `path` 和非空的 `edits` 数组；单处修改也使用数组：

```json
{
  "path": "src/config.ts",
  "edits": [
    { "oldText": "timeout: 1000", "newText": "timeout: 5000" },
    { "oldText": "retries: 1", "newText": "retries: 3" }
  ]
}
```

每个非空 `oldText` 必须在同一份原始文件中唯一匹配，各项不能重叠或嵌套；后面的项不能依赖前面替换后的内容。工具先检查全部修改，再一次写入；匹配失败、重复或重叠时不修改文件，也不创建 checkpoint。错误会指出对应的 `edits[i]`。`newText` 为空表示删除匹配内容。创建或完整覆盖文件使用 `write`。

匹配只容忍 LF、CRLF、CR 的表示差异，不忽略缩进、空白或 Unicode 字符。匹配区间外保留原始内容，包括 BOM、混合换行和末尾换行状态。替换文本使用匹配区间的首个换行风格；区间不含换行时采用文件首个换行风格，无换行文件采用 LF。无效 UTF-8 或含 NUL 的文件拒绝编辑。

主 agent 和 worker 使用相同工具与共享写入入口，继续执行路径检查、写入范围检查、同路径协调、取消处理和可选 checkpoint。

### 覆盖前的文件版本检查

`write` 创建新文件不要求先读；覆盖已有文件时，必须先通过 `read` 读取，并让成功结果进入较早一步的模型请求。同一工具批次中的读取尚未影响模型判断，因此不能授权该批次中的覆盖。范围读取也会记录文件版本，但这并不表示模型读完了整个文件；局部修改仍应使用 `edit`。

读取版本随工具结果保存，每次模型请求根据实际保留的结果重建。摘要、被跳过的未完成响应、已经压缩掉的读取结果都不能替代读取凭据；切换 Session、rewind 或恢复执行时也只使用当前上下文里的凭据。写入先校验读取凭据，缺失或版本不符时返回错误，要求重新读取并生成修改，不进入备份和覆盖步骤。

自身成功的 `write` 会记录所写内容的版本，不必为了后续覆盖而立即重读。`edit` 仍按唯一、非重叠的精确文本匹配执行，不新增强制先读规则；如果编辑前的版本仍与模型已知版本一致，编辑成功后也会更新凭据。否则，精确编辑的成功不能授权随后基于未知内容的整文件覆盖。

不超过 1 MiB 的文件沿用完整读取缓冲区计算 SHA-256；更大的文件保持范围读取，只记录文件身份、大小、修改时间和状态变更时间，避免为了版本检查额外扫描整个大文件。读取前后会检查版本稳定性；实际写入在已有的同路径队列内校验，并在 checkpoint 保存后再次检查目标与版本。如果在最后这次检查才发现变化，写入仍会拒绝，但可能已经留下本轮的备份记录。关闭 checkpoint 不关闭这些检查。

这不是跨进程的原子比较并写入：外部编辑器仍可能在最后检查之后修改文件，大文件的元数据检查也不是内容哈希。Bash 和任意自定义写入不受此规则约束。全局记忆原有的读取可见性、内容比较与进程内协调继续保留。

## 文件 checkpoint 与会话回退

`fileCheckpoints` 默认 `false`。关闭时，内置 `write` 和 `edit` 仍可工作，但不保存文件备份或追加 `file_edit` 记录；路径检查、取消处理、主 agent 与 worker 的同路径写入协调仍然生效。Session Tree 的会话和工具执行记录继续持久化，因此关闭文件 checkpoint 不等于使用内存会话。

worker 的内置 `write` 和 `edit` 在共享写入入口校验任务的 `writeScope`，拒绝修改范围外的实际路径；检查发生在文件备份和修改之前，进入同路径写入队列后再次确认目标。文件范围只允许该文件，目录范围允许其后代，符号链接不能扩大范围；返工沿用原任务范围。宿主策略放行不会跳过这项检查。它不限制任意 bash 命令或自定义工具的文件副作用，也不是操作系统沙箱。详见 [Worker 架构](./worker-architecture.md)。

开启 `fileCheckpoints: true` 后，内置文件编辑工具会保存每轮首次修改前的文件内容。worker 的记录归属于主 agent 的父 turn；bash、脚本和自定义工具的任意文件修改不会因此自动获得 checkpoint。

文件 checkpoint 只覆盖项目内的文件。授权的项目外目录（包括全局 Skill 安装目录）可以编辑，但不进入项目文件备份，`rewind()` 不会还原这些外部文件。

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

内置模型客户端在续接请求时，会一起跳过以 `aborted` 或 `error` 结束的未完成助手响应及其工具结果，避免留下没有对应调用的工具结果。完整助手响应之后发生的工具取消仍保留调用与取消结果。原始消息和诊断信息继续保存在 Session Tree 中。

`activeTurn` 为 `{ turn, entries, tasks }` 或 `null`，包含目标会话正在运行的一轮及其已记录的输入、助手内容、工具调用和结果。它与顶层已提交的历史分开；完成、中断或失败后，该轮进入 live path，`activeTurn` 变为 `null`，不重复返回。运行中查询通过会话索引定位这一轮，不需要复制其他会话的历史。未形成记录的流式增量不在此快照中，刷新后继续通过 `subscribe()` 接收进度。

Session Tree 通过 `fs-native-extensions` 使用操作系统文件锁保护整个 runtime 的持久化写入。正常关闭或进程退出会释放锁；`session-tree.lock` 文件保留，文件存在或其中的旧 PID 文本不代表被占用，也不要通过删除它解锁。升级到该锁协议前须先退出使用同一数据目录的旧版进程；旧版只识别 PID 文件，不应与新版同时运行。旧锁文件可以直接复用，无需清理；会话日志格式不变。

凭据存储 `auth.json` 也使用同一个操作系统锁实现，保护读取、OAuth 刷新和原子写回的整个操作。等待锁支持取消，不再按 PID 或锁文件年龄判断是否可以接管。`auth.json.lock` 会保留；升级前应先退出仍使用旧凭据锁协议的进程，避免两套协议同时操作同一凭据文件。凭据 JSON 格式没有变化。

每轮开始时创建执行器，捕获该轮的模型、思考级别和系统提示词。执行中通过 `setThinkingLevel()` 或 TUI 的 `Shift+Tab` 调整偏好，不改变当前轮后续模型步骤；下一轮使用新设置。

主回合先完成 turn 持久化，再运行扩展和模型；所有模型步骤都通过同一个上下文构建器读取已落盘的 turn。工具执行记录仍须在相应工具产生副作用前落盘，写入类工具继续等待完整 assistant 消息持久化。

### 压缩后的上下文

压缩生成累计的项目状态摘要。如果原始消息的保留窗口从一轮中间开始，还会生成该轮较早步骤的进度检查点。在这种情况下，后续模型请求依次包含项目状态摘要、逐字保留的该轮用户请求、进度检查点，以及较新的原始消息。原始 Session Tree 记录仍然保留。

两份摘要只描述各自所见材料结束时的状态，摘要模型看不到后面保留的新消息。提示词和摘要包装都会说明这条时间边界，要求继续执行的模型结合较新的用户指令和实际结果判断剩余工作，避免重复执行摘要中的旧下一步。摘要本身不构成新的任务或额外授权。

历史摘要继续使用 Long-term memory、Current project state、Recent user-agent conversation 和 Standing notes 四个栏目，优先保留授权范围、未完成工作、阻塞和必要证据，同一事实尽量只记录一次。轮内检查点按完成事项与证据、未完成工作、阻塞与不确定点、截至切点的下一步组织，空栏目可以省略，不复述原始用户请求或一般项目背景。

滚动更新时，提示词要求保留仍有效的约束和未完成的授权任务，不能仅因近期没有再次提及就删除；暂停、阻塞和等待用户决定的工作也应保留对应状态。用户请求、助手建议、引用内容和工具结果需要区分来源，已检查、已修改、已验证、已向用户交付等状态不能混为一谈。

## 取消、完成与预算

内置模型客户端对 Pi 识别的可重试服务端/网络错误，以及 `unknown certificate verification error`，默认最多重试 10 次（不含首次请求），等待从 500ms 开始逐次翻倍；请求的 `maxRetries` 和 `retryBaseDelayMs` 可覆盖默认值。重试沿用相同的请求上下文，等待支持取消，主 agent 的 TUI 会显示重试次数和等待时间；持续失败时返回原始错误。证书错误的识别由 `patches/@earendil-works%2Fpi-ai@0.85.1.patch` 补入 Pi 现有重试器，`bun install` 自动应用，升级 Pi 时需同步检查补丁。重试仍执行正常的 TLS 证书验证。

主 agent、Worker 和 Dreamer 的每次模型请求直接使用各自的 `ModelClient.maxOutputTokens`（自定义模型配置中的 `maxTokens`）作为输出上限，不再额外限制为 16,384 tokens 或上下文容量的 20%。内置模型适配器仍按剩余上下文调整请求额度；采用数值思考预算的协议在模型总输出上限内分配思考 tokens。

历史摘要和轮内进度摘要的提示词分别要求将完整正文控制在 4,000 和 1,000 tokens 内。压缩规划仍分别为两份摘要预留 4,000 和 1,000 tokens，不因请求输出上限放宽而减少保留原始消息的预算。

摘要请求的 `maxTokens` 分别设为 `min(6,000, model.maxOutputTokens)` 和 `min(2,000, model.maxOutputTokens)`，在提示词要求的长度之外留出生成余量。请求上限是否传给服务端取决于模型适配器；当前 Pi 的 Codex 订阅通道不传该参数，因此该通道依赖提示词控制摘要长度。

Thread 不在本地裁剪摘要，也不因 `stopReason: "length"` 单独拒绝或重试响应；现有的错误、工具调用和空结果校验保持不变。

`prompt()` 返回时，当前 turn 的工具收尾、历史结算和必要持久化已结束。结果的 `outcome` 区分 `completed`、`interrupted` 和 `failed`。调用参数无效、目标不存在、实例已关闭等请求错误会拒绝 Promise。

`interrupt()` 和 `close()` 都是完成屏障。重复 `close()` 返回同一个 Promise；开始关闭后拒绝新的操作。宿主应在退出时等待这个 Promise，不要仅通知取消就释放进程。

取消是协作式的。模型和自定义工具收到的 `signal` 必须传给底层 I/O，并在取消后完成资源清理。runtime 会等待它们结算；超时不会强杀任意进程内 JavaScript。

`maxSteps` 限制一次用户请求中的模型步骤数，包括上下文溢出后的恢复步骤；传输重试不另算步骤。`timeoutMs` 到期请求取消。限制触发后，结果中的 `limit` 标明 `maxSteps` 或 `timeout`。也可以传入宿主的 `AbortSignal`，或由停止按钮调用 `interrupt(sessionId)`。如果任务需要在浏览器断线后继续执行，应由后端持有 runtime，避免把任务的 signal 绑定到浏览器请求寿命。

## 事件和扩展

`RuntimeEvent` 携带 `timestamp`（Unix 毫秒）、`executionId`、`agentId`、`sessionId` 和 `turnId`。自主后台运行的 session/turn 为 `null`。主 agent、worker、Dreamer 使用相同的平铺事件；worker 另外携带 `taskId`、`revision`、`parentExecutionId` 和 `parentToolCallId`。`executionId` 对主 agent 是 turn ID，对 worker 是 task ID（用 revision 区分修订），对 Dreamer 是本次批次的独立 ID。TUI 在展示入口转换 worker 事件。

模型输出带 `entryId`，工具事件带 `toolCallId` 和发起调用的 `assistantEntryId`。同步或异步观察者异常不改变任务结果；runtime 不等待异步观察者，取消订阅也不会取消任务。事件数据是副本。观察者应立即记录必要数据，把网络发送放入自己的有界队列；耗时的同步回调仍会占用 JavaScript 线程。

### 模型与工具观测

| 事件 | 内容 |
| --- | --- |
| `model_call_started` / `model_call_finished` | 一次 `ModelClient.stream()` 逻辑调用；`callId`、模型、purpose、参数、结束状态、用量和时长 |
| `model_attempt_started` / `model_attempt_finished` | 内置模型客户端的一次实际请求尝试，包括失败后将重试的响应；通过 callId 和 attempt 关联 |
| `tool_started` | `phase: queued` 为进入准备/排队；`running` 为调度器放行，参数是准备和策略处理后的实际参数 |
| `tool_finished` | completed、failed、cancelled 或 denied；进入执行边界的调用包含 durationMs；content 为模型可见的工具结果，details 为工具返回的可选结构化元数据。取消时 content 为诊断文本（会话封口可能另补中断结果） |
| `agent_run_started` / `agent_run_finished` | worker 每次修订和 Dreamer 每个批次的输入、输出、结束状态 |
| `turn_started` / `turn_finished` | 用户任务生命周期；结束事件包含最终助手文本 output。completed 表示正常结束，不是评测通过 |

模型观测覆盖主 agent、worker、Dreamer，以及历史摘要和轮内进度摘要；后两者的 purpose 分别为 `history_summary`、`progress_summary`。压缩使用独立 executionId；自动压缩关联当前 turn，手动压缩保留目标 turnId，但不把自己作为已完成轮次的子执行。

工具结果消息的 `details` 使用 `ToolResultMetadata`：`raw` 保存原始工具结果的文本与元数据（图片字节只保存在消息内容中），`outcome` 保存结束状态，`durationMs` 保存执行边界内测得的耗时（不含排队等待）。内置文件工具可返回 `ToolResult.fileObservation`，形如 `{ path, version }`；执行器将其保存到 `details.fileObservation`，作为当前模型上下文的文件版本凭据，不放入 `raw` 或模型正文。工具自身的结构化数据位于 `raw.details`，也通过 `tool_finished.details` 提供；这些元数据不追加到模型可见的结果正文。`read`、`grep` 等提供数量和分页信息，`edit`、`write` 提供本次实际写入的 diff 与增删行数。Diff 只用于展示：前后内容总计超过 256 KiB、内容无法作为文本解码或计算超过 50ms 时，返回 `diffUnavailable` 原因，不因此阻止文件修改。UI 和宿主不应通过后续读取当前工作区重建当时的 diff。

`model_call_finished.usage` 来自最终模型响应，不能与 attempt 用量重复相加。`attemptsObserved > 0` 时按 attempt 统计；为 0 时按逻辑调用统计。自定义 ModelClient 可以通过 `ModelRequestOptions.onAttempt` 报告内部尝试；不提供时 runtime 不猜测其内部重试或费用。没有响应时 usage 缺失，不应解释为零。`firstOutputAt` 是首次可见文本/思考增量或完整工具调用的时间；durationMs 使用单调时钟，不保证等于底层 HTTP 请求耗时。

完整模型输入、响应需显式订阅：

```ts
const unsubscribe = runtime.subscribe((event) => {
  if (event.type === "model_call_started") {
    // event.input: Context after runtime context processing, before provider serialization.
  }
  if (event.type === "model_call_finished") {
    // event.response: complete AssistantMessage, including usage and stopReason.
  }
}, { captureModelContent: true });
```

`captureModelContent` 默认 false，在每次模型调用开始时决定是否捕获；未选择它的订阅者不会收到 input/response。已有工具参数、工具结果和文本增量仍可见，该选项不是权限隔离。导出器应自行决定内容采集、脱敏、截断、采样和保留策略。普通 `prompt({ onEvent })` 回调不包含完整模型 input/response。

### 外部适配器与关闭

外部适配器只需依赖 `thread/runtime` 的订阅和公共查询；Langfuse/OTel SDK、凭据、数据映射、网络队列和 flush 都由适配器管理。宿主应先等待 `runtime.close()` 收齐终态，再取消订阅并等待适配器 flush/close；runtime 不关闭宿主共享的遥测客户端。

coding 应用沿用 `--extension <module>`，也可调用 `app.loadExtension(specifier)`。ExtensionAPI 提供相同的 subscribe、listSessions、readSession、readHistory、agentTaskDetailsForTurn。CLI 相对路径仍以启动目录为基准；app.loadExtension 相对路径以 runtime.rootPath 为基准。扩展的 activate/default 函数可返回异步清理函数：应用在 runtime 收尾之后调用它，清理失败不改变任务结果，CLI 仍受原有 5 秒关闭期限约束。`on()` 是可干预执行的扩展钩子；观测使用 subscribe。

[独立用量扩展示例](../examples/observability.ts) 同时可用于嵌入宿主与 `--extension`，只导入公共 runtime 类型，按 attempt 优先统计，避免重复计算。

流式增量是临时进度，订阅不是持久化事件重放接口。`turn_started` 和 `turn_finished` 在相应持久化屏障后发布。需要网络重连时，适配层应协调状态快照和后续事件之间的衔接。

宿主工具策略与普通观察者分开。策略收到准备后的 `args` 和已解析的 `resources`，可按资源的 `namespace`、`resource`、`access`、`scope` 判断权限。主 agent、worker 和后台 agent 均使用该策略；拒绝后的调用不会执行。传给策略和资源声明函数的数据是副本，修改它们不会改写后续执行。自定义工具必须如实声明其资源；策略回调不等同于进程沙箱。

通过 `askPresenter` 提供交互能力，可以传入公共入口导出的 `AskService`，或实现自己的 `AskPresenter`。工具发起的 `AskRequest.invocation` 标明 session、turn、tool call 和 agent 身份。取消或关闭 runtime 会取消它正在等待的问题，并等待 turn 结算；宿主传入的 `AskService` 仍由宿主负责 `dispose()`，可被其他客户端继续使用。

当前版本继续使用本地 Session Tree 存储和 Bun，不引入服务器、远程文件系统、通用存储接口或分布式执行。第二个真实宿主需要这些能力时，再增添对应适配器。
