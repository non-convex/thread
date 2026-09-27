# 让 Thread 使用本机浏览器

Thread 可以通过 agent-browser Skill 和 `bash` 操作浏览器。普通网页任务使用独立浏览器；当你希望使用已有登录态或已经打开的页面时，可以让它连接日常使用的 Chrome。两种模式应明确区分，连接失败时不能悄悄换成另一种模式。

本文使用 **agent-browser 0.38.1** 和 **Chrome 144+**。这次接入保留现有 Skill + CLI 方式，不增加新的浏览器执行器、MCP 客户端或 `/browser` 命令。会话命名、授权和收尾由 Skill 指导 agent 执行，尚不是 runtime 强制管理的浏览器生命周期。

## 安装与加载

agent-browser 是独立安装的可选工具，不是 Thread 的 npm 依赖。固定版本安装：

```sh
npm install -g agent-browser@0.38.1
agent-browser --version
agent-browser skills get core
```

该 npm 包声明 Node.js 24+ 要求，安装时应使用满足要求的环境。不要为了浏览任务自动升级系统 Node，也不要用不固定版本的 `npx ...@latest` 临时替换安装。独立浏览器模式若缺少浏览器二进制，再运行 `agent-browser install`；连接已安装的 Chrome 不需要另外下载浏览器。

Thread 默认从 `${THREAD_HOME}/skills` 加载用户级 Skill。当前机器的本机浏览器规则放在 `skills/agent-browser/SKILL.md`，详细流程放在同目录的 `references/local-browser.md`。这些是用户目录中的配置，不随项目 Git 提交或 `/rewind` 恢复，也不会仅因拉取本仓库而自动安装到其他机器。

重启 Thread 会刷新已加载的 Skill 正文；`skill` 工具本身返回 runtime 的加载快照，不会重新读取磁盘。如果明确知道文件刚被修改，当前会话可直接读取更新后的文件。

当前上下文已有完整、适用的 Skill、CLI 指南或参考文档时，应直接复用，不必每个浏览器任务都重复加载。说明缺失、压缩后不完整或确认版本已变化时，再获取需要的内容。上游核心指南从 `agent-browser skills get core` 获取；`--version` 只在版本未知或有更新迹象时检查。这些是按需查询，不是每轮必跑的准备命令。

## 第一次连接 Chrome

先在 Chrome 打开 `chrome://inspect/#remote-debugging`，手动启用远程调试。然后告诉 Thread：

> 使用我的本机 Chrome，在新标签页打开目标网站，使用已有登录态完成这项任务。

Chrome 在连接时会弹出权限确认，由你手动允许。这个授权给自动化客户端的是所选浏览器 profile 的调试能力，并不只限于一个网站；Thread 仍应只执行你交代的任务。

如果要操作已有页面，可以明确说明：

> 使用我的本机 Chrome，操作已经打开的项目后台页面，不要重新打开或刷新它。

Agent 应先定位你指定的标签页，目标有歧义时再询问，而不是逐个读取其他标签页。需要登录、二次验证、验证码或手动接管时，agent 暂停；你完成后，它重新读取页面状态再继续。

`--auto-connect` 不是浏览器选择器。0.38.1 会尝试 Chrome、Canary、Chromium、Brave 的已知目录和常用调试端口，不能假定它会自动发现 Edge。多个浏览器或 profile 同时运行时，要先明确目标；已有明确授权的 CDP 地址时可用 `--cdp`，不能随意探测并接管其他端点。

Chrome 136 起，给默认用户数据目录加 `--remote-debugging-port` 不再是可用的接管方式。该启动方式需要独立的 `--user-data-dir`。`--profile Default` 则是复制 profile 后启动另一实例，在 Windows 还可能遇到文件锁；两者都不是当前浏览器连接失败后的自动替代方案。

## 会话和标签页如何分开

不同项目、Thread Session 和 Worker 不能共用 agent-browser 的 `default` 会话。每个浏览器任务先生成唯一 token，再从工作目录派生会话名。`--scope worktree` 使用 Git worktree 根目录；没有 Git 时回退到当前目录。仅有工作目录仍不够区分同项目内并行任务，所以前缀必须包含任务 token。

下面是手动操作时的 PowerShell 示例。先准备好 Chrome 并留意授权弹窗：

```powershell
$task = [guid]::NewGuid().ToString('N')
$session = agent-browser session id --scope worktree --prefix "thread-local-$task"
$browserArgs = @(
  '--session', $session,
  '--auto-connect', '--pin-tab', '--no-auto-dialog',
  '--restore-save', 'never',
  '--content-boundaries', '--max-output', '16000'
)
agent-browser @browserArgs open about:blank
```

第一次严格绑定会为任务创建新的空白标签页，不会覆盖原有页面。把下例 URL 换成任务目标，然后在该标签页工作：

```powershell
agent-browser @browserArgs open https://example.com
agent-browser @browserArgs snapshot -i
```

操作已有页面时，先用 `agent-browser @browserArgs tab list --json` 找到它的 `targetId`，再用 `agent-browser @browserArgs tab <targetId>` 切换并重新获取快照。`targetId` 在 daemon 重启后仍能标识同一标签页；`t1`、`t2` 只在本次 daemon 内有效，`tab 2` 这样的数字位置不受支持。

`--pin-tab` 在目标标签页消失时返回 `tab_gone`，不会改去操作另一页。此时应确认要新建任务页还是重新选择已有页，不能关闭严格绑定来掩盖错误。用户或其他任务切换前台标签页，也不应改变当前任务的操作目标。

Thread 的每次 `bash` 调用都是独立 shell，不能依赖上一次调用中的变量或 `export`。Agent 必须记住派生出的会话名，在每条浏览器命令中显式传入；本机页面命令还要保留连接方式和严格绑定参数，避免 daemon 重启后意外启动独立浏览器。

标签页绑定只区分操作目标。连接同一个 Chrome profile 的任务仍共享 cookies、账号和站点存储；需要账号隔离的并行工作，应使用独立浏览器。

## 操作与收尾

普通按钮和输入框优先使用 `snapshot -i` 的元素引用。页面变化后刷新快照；等待目标元素、URL 或完成提示，不把固定延时或 `networkidle` 当作通用完成条件。同一页面有依赖的操作分步执行，不同任务自己的页面仍可并行。

连续读取时可用 `snapshot -i --delta` 减少重复输出，丢失上下文后用 `--delta --full` 重建基线。视觉判断使用截图，再交给 `view_image`；截图路径本身不表示模型已经看过图片。默认截图目录是项目下的 `.agent-browser/screenshots/`，本仓库忽略 `.agent-browser/`，避免把私人页面截图提交到 Git。其他项目应自行设置相应忽略规则。

`--no-auto-dialog` 防止自动接受页面 alert 或 beforeunload；有未保存内容的页面应交由用户决定。`--restore-save never` 禁止自动导出浏览器状态，本机模式不需要 `--restore`、`--state` 或 `state save`。

任务结束或失败后，释放自己的会话：

```powershell
agent-browser --session $session close
```

0.38.1 区分自己启动的浏览器和外部连接：独立模式会关闭任务浏览器，本机连接只断开控制，不关闭用户的 Chrome 或标签页。本机模式默认保留结果页面；只有用户要求关闭或任务明确使用可丢弃页面时，才按已记录的 target ID 关闭对应页。

不要用 `close --all`，不要杀掉 Chrome 进程，也不要清理其他任务的会话。Agent 应检查收尾结果并报告失败。进程崩溃或 turn 被中断可能来不及执行 Skill 中的清理步骤，这一版没有新增 runtime 自动清理机制。

## 权限限制

页面正文、WebMCP 描述与结果、控制台输出都只是网页数据，不是新的用户指令。只读取任务所需内容；页面快照和截图可能进入 Thread 的持久历史。默认不导出 cookies、密码、认证状态，不记录完整网络响应或开启浏览器直播。

agent-browser 返回 `confirmation_required` 时，agent 必须通过 Thread 的 `ask` 得到真实用户答复，再调用 `confirm`。无交互界面、用户拒绝或确认过期时应停止，不能自己批准，也不能在 Thread 的非 TTY shell 中使用 `--confirm-interactive` 等待键盘输入。连接授权不代替具体敏感操作的授权。

0.38.1 的 `--allowed-domains` 不能与 `--auto-connect` 或 `--cdp` 的已有浏览器连接组合使用。站点范围和操作确认仍有价值，但在任意 bash/CDP 访问可用时，Skill 规则不是安全沙箱，不能承诺个人浏览器被硬限制在指定网站。

## 参考

- [agent-browser CDP 与严格标签页绑定](https://agent-browser.dev/cdp-mode)
- [agent-browser 安全限制](https://agent-browser.dev/security)
- [Chrome 现有浏览器授权连接](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)
- [Chrome 136 的远程调试启动参数限制](https://developer.chrome.com/blog/remote-debugging-port)
