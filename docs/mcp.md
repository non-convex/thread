# 接入 MCP 工具

Thread 可以把 MCP 服务器提供的工具交给主 agent 使用。本地服务通过 stdio 启动，远程服务通过 Streamable HTTP 连接。MCP 工具与内置工具共用参数校验、宿主授权、取消信号、执行事件和会话记录，不需要另一套 agent 执行器。

这是可选能力。没有配置服务器时，不会启动 MCP 子进程或建立 MCP 网络连接。MCP 工具不会自动进入 Worker 或 Dreamer，也不会替换现有的 agent-browser Skill。

## 配置一个服务器

在用户级 `~/.thread/config.json`（或 `THREAD_HOME/config.json`、CLI 的 `--config` 指定文件）中添加 `mcpServers`。下面是配置片段，需要将路径、地址和工具名替换成实际服务提供的值；它不会自动安装服务。

```json
{
  "mcpServers": {
    "local_docs": {
      "transport": "stdio",
      "command": "node",
      "args": ["D:/tools/docs-mcp/server.js"],
      "env": {
        "DOCS_API_KEY": "${DOCS_API_KEY}"
      },
      "enabledTools": ["search", "get_document"]
    },
    "remote_docs": {
      "transport": "http",
      "url": "https://docs.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${DOCS_MCP_TOKEN}"
      },
      "enabled": false
    }
  }
}
```

每个配置项的键是本地服务器 ID，使用 1–64 个英文字母、数字、下划线或连字符。它用于 `/mcp` 管理和工具命名，不依赖服务器自行报告的名字。

stdio 的 `command` 是可执行程序，参数分别放在 `args` 中，不是整段 Shell 命令。`cwd` 可选，默认是当前项目目录，相对路径也以项目目录为基准。服务包应由用户先安装并固定版本，不建议使用每次自动下载最新版的启动命令。子进程继承 SDK 的基础环境变量，再叠加 `env`，不会直接继承 Thread 的全部环境变量。

HTTP 使用准确的 MCP endpoint，不自动退回旧 SSE transport，也不跟随 HTTP 重定向。远程地址必须使用 HTTPS；只有 `localhost`、`127.0.0.1`、`[::1]` 可以使用 HTTP。不接受 URL 中的用户名、密码或 fragment；凭证应放在 header，避免写进 URL。

CLI 加载配置时，在 `env` 和 `headers` 的值中解析 `${NAME}` 或 `$NAME`；`$$` 表示字面量 `$`。未定义的变量会报告配置错误。这里不执行 `!command` 凭证命令，也不展开 `command`、`args`、`cwd` 或 URL。`enabled: false` 的项不会解析环境变量，也不会连接。

配置项默认启用。`enabledTools` 是远端原始工具名的白名单：省略表示允许这个受信任服务器提供的全部工具，空数组表示不提供任何工具。建议只开放实际需要的工具；新增远端工具在白名单之外不会自动获得调用权限。

配置只在启动时加载。修改配置或凭证环境变量后，需要重启 Thread；`/mcp reconnect` 使用本次启动时的配置，不重新读取文件。第一版不自动查找或执行仓库里的 `.mcp.json`。

## 查看状态和重连

使用 `/mcp` 查看服务器状态、当前已发现的工具、最近错误和有限长度的 stderr。这个命令在 agent 执行中也能使用，内容是临时文档，不写入会话历史。

```text
/mcp
/mcp reconnect local_docs
```

重连仅在 runtime 空闲时允许。它关闭原客户端，按原配置重新连接并发现工具，不重放上一次失败的工具调用。禁用项需要修改配置并重启后才会启用。

启动时并行连接已启用的服务。单个服务器连接或发现失败会显示诊断，不妨碍使用其他服务器和 Thread 内置工具。运行期间断线不会自动重启服务；用 `/mcp reconnect` 显式恢复。

同一个 runtime 内，每个服务器持有一个客户端。切换 Session、创建定时任务 Session 或开启下一轮对话都不会重新启动服务器。关闭 runtime 时，先取消并收尾调用，再关闭客户端和由 SDK 启动的 stdio 子进程。HTTP 仅释放客户端及服务分配的协议会话，不关闭远端服务。子进程关闭不构成对任意孙进程或服务端后台工作的终止保证。

## 超时与协议版本

每个服务器可设置 `startupTimeoutMs` 和 `toolTimeoutMs`，默认分别为 10 秒和 60 秒。前者限制连接与初始发现，也用于后续目录刷新；后者限制单次工具调用，不会因 progress 消息无限延长。

Thread 使用官方 `@modelcontextprotocol/client` v2。HTTP 默认使用 SDK 的自动协议协商；stdio 默认使用 SDK 的 `legacy` 握手，避免探测时额外启动一个服务器进程。stdio 服务如果需要新版协议，可配置 `"protocol": "auto"`。自动探测可能启动短命探测子进程，浏览器等有启动副作用的服务应先确认是否适合；Thread 不自行实现另一套协议兼容逻辑。

工具发现使用 SDK 的分页、缓存和目录变更通知。每轮开始前检查目录，缓存是否可复用由 SDK 的 TTL 和失效通知决定。新目录用于新一轮；执行中的轮次保持其工具名和参数定义。目标模式的每次续轮、定时任务唤醒也经过这一步。

## 返回内容与限制

模型侧工具名通常是 `mcp__服务器ID__工具名`。特殊字符、过长名称或分隔符歧义会采用稳定哈希后缀，名称最多 64 个字符；向服务发送请求时仍使用原始工具名。启用 MCP 时，`mcp__` 前缀保留，宿主自定义工具不能使用它。

JSON Schema 保留远端参数语义，不把复杂 schema 简化成任意对象。参数仍经过 Thread 原有校验；SDK 根据本轮工具定义验证声明了 output schema 的结构化返回。工具返回 `isError: true` 时，Thread 仍将其作为失败交给模型，而不会因为 HTTP 成功就记录成工具成功。

文本与结构化 JSON 一并提供给模型，完全相同的文本 JSON 不重复追加。图片经过现有图片处理流程，以真正的图片块交给支持视觉的模型。不支持的图片、音频或二进制资源会明确提示省略。资源链接只显示 URI 和说明，不会自动下载。

为控制内存和上下文使用，首版设定以下边界：

- 工具发现最多 16 页；完整目录最多 512 个工具、1 MiB JSON，白名单过滤在完整目录检查之后。超过时需要服务端缩小目录。
- stdio 接收缓冲区、单次 HTTP 响应各限制为 10 MiB；HTTP 限制也包含 SSE 流的累计字节。
- 单次结果最多处理 128 个内容块，模型文本最多约 64 KiB，截断会有说明。
- 最多附带 4 张图片，处理后图片总大小最多 8 MiB；每张仍受原有 8 MiB 输入和 2000 万像素限制。
- stderr 只保留最近约 4 KiB，持续读取以免堵住子进程。诊断会移除已配置凭证的字面值，但仍应把服务日志视为可能含有敏感内容。

Thread 不自动重试工具调用，并关闭 SDK 的交互式自动续调；传入本轮捕获的工具定义，也避免 SDK 在 header mismatch 后刷新并重发该调用。取消信号传到 SDK 请求和 HTTP I/O，但取消或超时不证明远端没有完成操作，也不撤销既有副作用。结果不确定时，应先查询实际状态再决定是否重试。

## 权限边界

配置并启用服务器，意味着用户信任这个程序或 endpoint，并允许所选工具进入主 agent 的工具列表。`enabledTools` 控制可见范围；嵌入宿主还可以用 `toolPolicy` 按调用决定是否放行。服务的只读、幂等或破坏性 annotations 不会被直接当作授权依据。

MCP 工具统一声明 `effect: "process"`，在完整助手响应持久化后才开始执行；资源声明使用 `namespace: "mcp"`，`resource` 是 `[服务器ID, 原始工具名]` 的 JSON 字符串。它描述调用目标，不声称知道服务会访问的全部文件或网络地址，也不会把同服务器调用串行化。相互依赖或修改共享状态的操作仍应分步调用。

MCP 服务是外部代码。它修改文件时不经过 Thread 内置文件写入边界，不能自动享受路径保护、Worker 写入范围检查或文件 checkpoint；`/rewind` 不会撤销这些文件变化。服务器提供的描述、返回文本和日志也不是提高指令优先级或扩大权限的依据。

首版不支持交互式 OAuth 登录、完整 Resources/Prompts 入口、Sampling、Elicitation、Tasks 和 MCP Apps。需要 OAuth 的服务会提示检查认证，并明确说明尚不支持交互登录；不会自动打开浏览器或请求模型代填凭证。

## 嵌入 runtime

宿主通过 `thread/runtime` 的 `ThreadRuntimeOptions.mcpServers` 显式传入配置。core 不读用户配置、不展开环境变量；宿主先解析凭证，再传入字面值。

```ts
const runtime = await ThreadRuntime.open({
  rootPath,
  model,
  mcpServers: {
    docs: {
      transport: "http",
      url: "https://docs.example.com/mcp",
      headers: { Authorization: `Bearer ${token}` },
      enabledTools: ["search"],
    },
  },
});

console.log(runtime.mcpServers); // 独立的状态快照，不暴露配置或 SDK 客户端
await runtime.reconnectMcpServer("docs", { signal }); // 仅空闲时；重连失败见状态快照
await runtime.close();
```

连接实现和工具适配分别位于 `src/core/mcp/client.ts`、`tools.ts`。运行时负责资源所有权和每轮工具快照；app 只负责配置文件、环境变量和 `/mcp` 命令。没有另建工具执行器、持久化连接仓库或权限框架。
