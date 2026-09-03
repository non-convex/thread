# 把剪贴板里的图交给模型

Thread 的全屏 TUI 已经支持这条操作：

1. 截一张图
2. 在输入框里按 `Ctrl+V`（Windows Terminal 用户按 `Alt+V`，原因见下）
3. 输入框上方出现图片附件
4. 写一句话，也可以不写
5. 回车后，图片和文字一起交给模型

这篇不讲终端为什么不能直接显示一张粘贴进来的图。这里只顺着代码走一遍，说明每一步做了什么，以及为什么这样做。

---

## 1. 先认识一条用户消息

没有图片时，用户消息还是最简单的字符串：

```ts
{
  role: "user",
  content: "修一下这个布局"
}
```

有图片时，`content` 会变成一组内容块：

```ts
{
  role: "user",
  content: [
    { type: "image", mimeType: "image/png", data: "……base64……" },
    { type: "text", text: "修一下这个布局" },
  ]
}
```

`mimeType` 说明图片格式。`data` 是图片字节的 base64 表示，可以安全地放进 JSON，再交给模型接口。

Thread 使用的 `pi-ai` 本来就接受这种消息。实现图片粘贴，真正需要补的是前半段：从剪贴板得到图片，把它放进 composer 的附件列表，再沿着 turn 的提交链路送下来。

---

## 2. Ctrl+V 发生时，先看看剪贴板里有没有图

键盘入口在 `src/ui/terminal/view.tsx`。贴图有两个键：`Ctrl+V` 和 `Alt+V`，走的同一条读取链路。

用户按下 `Ctrl+V` 后，Thread 先尝试 `Bun.Image.fromClipboard()`。这一步主要服务 Windows 和 macOS。

这个调用有一个很有用的性质：它会立刻告诉我们剪贴板里有没有图片。

- 有图片：Thread 当场拦下这次按键，然后异步读取和处理图片
- 没有图片：继续走 OpenTUI 的 host clipboard，读取图片或普通文字

### 为什么还需要 Alt+V

终端自己也有粘贴键。**Windows Terminal 默认把 `Ctrl+V` 绑定成自己的文本粘贴**：按键在终端层就被消费掉，根本不会转发给 Thread。这时：

- 剪贴板里是文字：终端直接完成文本粘贴，Thread 收到的是粘贴事件，一切正常
- 剪贴板里只有图片：终端发现没有可粘贴的文本，什么都不发。`Ctrl+V` 看起来就是「坏了」

`Alt+V` 没有任何常见终端会拦截，所以它是 Windows 上可靠的贴图键。Claude Code、Copilot CLI 和 OpenCode 都是这个组合：`Ctrl+V` 为主，`Alt+V` 兜底。剪贴板里没有图片时，按 `Alt+V` 会提示 `No image in the clipboard.`，而不是无声无息。

在 macOS 上 `Alt+V` 是 Option+V，通常用来输入特殊字符；只有当剪贴板里确实有图时才会被拦截成贴图，其余情况照常输入。

OpenTUI 的读取器在 TUI 挂载时创建：

```ts
createHostClipboard({
  timeoutMs: 1_000,
  maxReadBytes: 8 * 1024 * 1024,
  maxImagePixels: 20_000_000,
})
```

这里有三道边界：

- 一次读取最多等 1 秒
- OpenTUI 返回的内容最多 8 MB
- 图片最多 2000 万像素

图片不是普通文本，不能让它无限大、无限等。边界放在读取入口，比等到模型请求时报错更容易理解。

如果剪贴板里只有文字，Thread 会把文字插回当前光标位置。所以 `Ctrl+V` 仍然可以做普通文本粘贴。

读取和编码期间，附件行会显示 `reading clipboard…`。这时回车不会抢先发送文字。按 Ctrl+C 清空草稿后，即使后台图片处理稍后结束，它的结果也不会重新冒出来。

程序退出时，host clipboard 会先 `dispose()`，然后才销毁 renderer。它和渲染器是两份资源，不能只释放其中一个。

---

## 3. 为什么 Windows 截图也能读

Windows 的截图经常以 DIB 位图留在剪贴板里，不一定同时提供 PNG。

Thread 没有在项目里自己实现 DIB 解码，也没有为了这件事强行升级 OpenTUI。Windows 和 macOS 的首选路径是 Bun 自带的 `Image.fromClipboard()`。Bun 会读操作系统提供的位图，再把它交给同一个图片处理管线。

因此 Win+Shift+S 之后按 `Ctrl+V`，不依赖剪贴板里恰好存在 `image/png`。

Linux 上 `Bun.Image.fromClipboard()` 会返回空。此时 Thread 使用 OpenTUI 的 host clipboard，依次询问 PNG、JPEG、WebP、GIF 和 BMP。

---

## 4. 图片先处理，再进入附件列表

图片处理集中在 `src/ui/images.ts`。

任何来源最后都会进入同一个函数：

- Windows / macOS 系统剪贴板
- OpenTUI host clipboard
- 带 MIME 的 OpenTUI paste event
- 用户粘贴的图片文件路径

函数先读图片头，取得宽、高和格式。文件和 OpenTUI 字节输入不能超过 8 MB；所有来源都受 2000 万像素限制，处理后的图片也不能超过 8 MB。系统剪贴板管线没有单独暴露“原始 DIB 有多少字节”，所以它在读出编码结果后检查体积。

最长边超过 1568 像素时，图片会保持比例缩小。小图不会被放大。

小而已经是 PNG、JPEG、WebP 或 GIF 的图片会直接保留。需要缩放或重编码时，再分成两类：

- 截图、PNG、GIF、BMP，以及带透明通道的图，编码成调色板 PNG
- JPEG、普通 WebP 等照片型输入，编码成质量 80 的 JPEG

这样做不是追求图片文件最漂亮，而是在三件事之间找平衡：

- 截图里的字不要糊
- 照片不要大得离谱
- 模型仍然拿到常见、可靠的图片格式

处理完成后才转 base64。composer 保存的是：

```ts
interface ComposerImage {
  id: string
  mimeType: string
  data: string
  width: number
  height: number
}
```

宽高只用于界面确认。真正发给模型的是 `mimeType` 和 `data`。

---

## 5. 附件不塞进 textarea

textarea 继续只保存用户输入的文字。

图片单独存在 `attachments` signal 里。只要附件不为空，输入框上方就多一行：

```text
image · 1280×720 png
```

多张图会写成：

```text
3 images · 1280×720 png · 900×600 jpeg · 640×480 png
```

行太长时会截断，不会把 composer 撑得很高。

目前最多附 8 张图。在空输入框里按 Backspace，会删掉最后一张。按 Ctrl+C 清空草稿时，文字和附件一起清空。

这里没有把 `[Image #1]` 写进 textarea。附件行已经告诉用户图片存在，再放一个可编辑的占位符，反而会产生两个状态：用户删了占位符，但图片是否还在？

所以附件列表是唯一真相。界面上的文字只是它的展示。

---

## 6. 回车后，图片怎样进入 turn

没有图片时，原来的调用方式不变：

```ts
planTurn(input)
```

有图片时，图片通过 `InputOptions.images` 跟着输入传到 `AgentRuntime`：

```ts
planTurn(input, images)
```

`planTurn` 会把两者组装成一条用户消息。图片块在前，文字块在后。只有图片、没有文字也是合法的 turn。

同一份组装结果会用于两个地方：

1. 写入 Session Tree 的用户 entry
2. 第一次请求模型时使用的 prepared context

这点很重要。如果持久化一份、第一次请求临时拼另一份，两边很容易慢慢漂开。现在 `PlannedTurn` 直接持有最终的 user `content`，两条路共用它。

---

## 7. 先确认模型有视觉能力

`pi-ai` 的模型元数据已经有：

```ts
input: ["text", "image"]
```

`PiModelClient` 会把它变成更直白的：

```ts
acceptsImages: true
```

模型列表会给这类模型标记 `vision`。执行 `/model` 时，也会看到当前模型是否支持 images。

发送新图片前，TUI 和 `ThreadApp` 都会检查一次。当前模型不收图时，附件留在 composer，不会被清掉；界面会提示先用 `/model` 换成视觉模型。

这里故意做了两层检查：

- TUI 检查负责不丢草稿
- 应用层检查保护 plain UI、嵌入调用和将来的其它入口

还有一种情况：历史里已经有图片，后来用户换成了纯文本模型。

纯文本模型收到图片块会报错。Thread 不会因此阻止模型切换，而是在发请求前把旧图片临时改成：

```text
[image omitted: current model is text-only]
```

Session Tree 里的原图没有改变。以后再换回视觉模型，原图仍然可以进入上下文。

---

## 8. 命令不会偷偷吃掉附件

用户贴好一张图后，可能先运行 `/model` 去换模型。

因此 slash command 提交时，附件不会跟着命令发送，也不会从 composer 清掉。命令结束后，它还在那里。

判断命令时不能只看第一个字符是不是 `/`。Thread 允许 `/usr/bin` 这种路径进入模型。只有第一个 token 是单段 slash 名字时，才按命令处理。

这和 `InputRouter` 的规则保持一致。

---

## 9. 粘贴图片路径是备用入口

在 SSH 或某些集成终端里，Thread 可能读不到你电脑上的剪贴板。这时可以先把图片存成文件，再粘贴路径。

Thread 对路径的判断很保守：

- 整段内容必须都是路径
- 文件必须真实存在
- 后缀必须是 PNG、JPEG、WebP、GIF 或 BMP
- 一次最多 8 条

`file://` URI 也会转成本地路径。

像下面这种普通句子不会被抢走：

```text
请检查文档里提到的 screenshot.png
```

路径确认失败后，原文字会回到输入框。这样「看起来像路径」不等于「一定是附件」。

---

## 10. 历史里怎样显示图片

模型需要 base64，用户不需要在 transcript 里看那一大串字符。

因此不同地方采用不同视图：

- 模型上下文：完整 image block
- Session Tree：当前版本保存完整 image block
- transcript：显示 `[image]`
- rewind 列表：显示 `[image]`，后面接用户文字
- Session 搜索与读取：图片位置显示 `[image]`
- Dreamer：只取对话文字，不把图片字节放进记忆审查

当前实现会把压缩后的 base64 直接写进 Session Tree JSONL。这样最简单，也保证重启和 rewind 之后仍能重放图片。

它不是最终最省空间的存法。更完整的下一步，是把图片字节放进按内容寻址的 blob store，消息里只留 hash 和 MIME；构建模型上下文时再展开。

在 blob 方案落地以前，1568 像素、8 MB 输入上限和重新编码共同控制日志增长。

---

## 11. 还有哪些边界

### SSH

远程进程看到的是远程机器的 host clipboard，不是你笔记本的。图片路径是最可靠的退路。

### VS Code 集成终端

如果 Ctrl+V 被 VS Code 快捷键拦截，Thread 收不到按键。需要调整快捷键，让它到达终端进程；或直接用 `Alt+V`。

### Windows Terminal

`Ctrl+V` 默认绑定到终端自己的粘贴，只有图片时什么都不发。用 `Alt+V` 贴图，或者从 Windows Terminal 设置里删掉 `Ctrl+V` 的 Paste 绑定。

### macOS

应用级贴图快捷键是 Ctrl+V。Cmd+V 通常仍由终端做普通文本粘贴；Option+V（Alt+V）在剪贴板有图时也会贴图。

### 预览

当前只有附件信息行，没有 Kitty / Sixel 缩略图。发送图片不依赖终端是否支持图片协议。

### 持久化体积

当前保存压缩后的 base64。大量连续贴图仍然会让 Session Tree 变大，blob store 是后续该补的边界。

---

## 12. 代码位置

- `src/ui/terminal/view.tsx`：Ctrl+V、paste event、附件 signal、Backspace 删除
- `src/ui/terminal/clipboard.ts`：OpenTUI host clipboard 的创建、读取和释放
- `src/ui/terminal/composer-paste.ts`：把各种粘贴来源收束成附件或文字
- `src/ui/images.ts`：图片校验、缩放、编码、路径读取
- `src/ui/terminal/session-screen.tsx`：附件行和提交行为
- `src/session-tree/user-content.ts`：图文消息组装、展示和纯文本模型降级
- `src/session-tree/service.ts`：把完整用户内容写进 turn
- `src/agent/runtime.ts` / `src/agent/turn-runner.ts`：把图文消息送进模型上下文
- `src/agent/model-client.ts`：从模型元数据读取视觉能力
- `test/image-input.test.ts`：图片处理、持久化、模型能力和模型切换测试
