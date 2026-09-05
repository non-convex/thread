# 怎样搜索和读取项目里的历史对话

当 agent 需要知道“之前为什么这样决定”时，通常先找出相关对话，再阅读当时的上下文。

Thread 为这两个动作提供了两个工具：`session_search` 返回相关 turn 的线索，`session_read` 返回选中 turn 的原文。一个 turn 是一轮完整交互，从用户发出请求，到 agent 完成、失败或被中断为止。

这篇文档按实际使用顺序介绍两个工具。如果想先了解索引、本地模型，以及历史怎样变得可搜索，可以阅读[项目记忆是怎样被搜索到的](./session-recall.md)。

## 从一个问题开始

假设用户问：

> 之前是不是讨论过，撤销之后要保留旧的对话分支？

agent 可以先调用 `session_search`：

```json
{
  "queries": ["撤销后旧分支还在吗", "rewind"],
  "limit": 5
}
```

第一条是自然语言描述，第二条是可能出现在历史中的具体词。它们会分别查找，再合并结果。两条查询不要求同时出现在同一轮里。

工具最终最多返回五个不同的 turn。即使一轮里有很多 entry、很多片段被搜到，它也只占一条结果。

## `session_search` 接受哪些参数

| 参数 | 类型 | 是否必填 | 含义 |
| --- | --- | --- | --- |
| `queries` | 字符串数组 | 必填 | 要寻找的描述、关键词或精确标识符 |
| `limit` | 数字 | 选填 | 最多返回多少个 turn，默认 8 |

`queries` 至少需要一个去掉首尾空白后仍不为空的查询。重复的查询会被合并。它可以包含自然语言，也可以包含路径、函数名或错误码。

`limit` 会向下取整，并限制在 1–50。例如传入 60 时，实际最多返回 50 个 turn。结果可能少于这个数量，特别是在相关内容较少、索引尚未完整或语义检索不可用时。

这个工具搜索当前项目所有已结束的 turn，包括其他 session 和 rewind 保留的分支。正在运行的 turn 暂时不参与。当前没有按 session、时间或 `kind` 过滤的参数。

## 返回的结果长什么样

两个工具目前都使用相同的返回外层：

```ts
type ToolResult = {
  content: string;
  isError: boolean;
};
```

成功时 `isError` 为 `false`，`content` 是供 agent 阅读的文本。下面的例子展示 `content` 内容；ID 和对话均为虚构，只用于说明格式。

假设刚才的查询找到了一轮讨论：

```text
Historical Session Tree evidence; verify the current workspace when correctness depends on it.
Keyword coverage: 120/120 ended turns.
Semantic recall: ready; coverage 120/120.

- session=session_demo turn=turn_demo [current-session-off-path] completed 2026-09-05T02:00:00.000Z
  entry=entry_demo; kind=assistant; sources: literal, keyword, semantic; queries: 撤销后旧分支还在吗, rewind
  rewind 只移动当前路径的末端，旧的 turn 和分支仍然保留，可以继续搜索和读取。

Semantic hits are related candidates and may not contain the query words. Use session_read with a turn id for original evidence.
```

开头的提醒说明这是历史证据。如果某个决定取决于代码现在的实际状态，还需要核对当前文件。

接下来先解释覆盖数量，再看每条结果。这样就能区分“没找到”和“还有部分历史没完成语义索引”。

### 覆盖数量表示已经处理了多少历史

`Keyword coverage: 120/120` 表示：当前有 120 个已结束的 turn，关键词索引已经完成全部 120 个。这个数字不是命中总数。

`Semantic recall: ready; coverage 120/120` 表示：语义检索已就绪，向量索引也已完成全部 120 个 turn。

新历史的关键词索引和向量索引可能在不同时间完成。即使向量部分还在处理中，也可以返回关键词结果，以及已经完成部分的语义结果。

语义状态有以下几种：

| 状态 | 应当怎样理解 |
| --- | --- |
| `preparing` | 模型正在准备，可能正在下载、校验或加载 |
| `indexing` | 模型已可用，仍有历史没有完成向量索引 |
| `ready` | 模型可用，本次查询范围内的历史已完成向量索引 |
| `disabled` | 配置关闭了语义检索 |
| `unavailable` | 语义检索这次无法使用，后面会说明原因 |

### 每条结果会告诉你去哪里读原文

`session` 表示这一轮属于哪个 session。`turn` 是随后传给 `session_read` 的 ID。

`entry` 则更具体：它指出展示的片段来自这一轮的哪条持久记录。一个 turn 可以包含用户消息、assistant 消息、工具调用和工具结果等多个 entry。

搜索内部先找到片段，再按 turn 合并。一条结果只展示其中一段相关文字，所以这里的 `entry` 和 `kind` 始终对应实际展示的片段。

片段最多展示 320 个 JavaScript 字符串单位，换行和连续空白会合并，便于浏览。它是阅读线索，完整内容通过 `session_read` 获取。

### `kind` 说明展示的是什么内容

同一句话出现在用户问题、assistant 的回答或工具日志里，含义可能不同。`kind` 用来保留这个区别：

| `kind` | 片段的内容类型 |
| --- | --- |
| `user` | 用户正文 |
| `assistant` | assistant 正文 |
| `thinking` | 已保存的模型思考内容 |
| `tool-call` | 工具名称和调用参数 |
| `tool-result` | 工具返回的内容 |
| `image` | 图片位置的 `[image]` 标记 |

`kind=assistant` 描述的是当前展示的片段，不表示整轮只有 assistant 消息。`image` 只表示图片标记，不代表系统已经识别了图片里写的文字。

### `sources` 说明怎样找到这轮对话

`sources` 记录检索方式。一轮对话可以同时通过多种方式被找到：

| 来源 | 含义 |
| --- | --- |
| `literal` | 提取出的文本中包含某个完整查询字符串，忽略大小写 |
| `keyword` | 通过分词后的关键词匹配找到 |
| `semantic` | 通过本地模型计算的语义相似性找到 |

这里的 `sources` 和 `queries` 是合并到这个 turn 的检索信息。它们可能来自同一轮里的不同片段，因此展示的那一段不一定包含所有列出的查询词。

特别是 `semantic`，表示意思可能相关。工具不把相似度当作事实可信度，也不声称原文一定出现过查询中的词。

### 方括号里的路径身份说明它现在处于哪里

| 路径身份 | 含义 |
| --- | --- |
| `current-path` | 当前 session 正在使用的路径上的 turn |
| `current-session-off-path` | 当前 session 中仍保留、但已不在当前路径上的 turn |
| `other-session` | 属于同一项目里的其他 session |

示例中的 `current-session-off-path` 表示它来自当前 session 保留的历史分支。它仍然可以阅读，但需要留意这可能是后来放弃的尝试。

后面的 `completed`、`failed`、`interrupted` 表示这轮交互是怎样结束的。时间使用 ISO 格式，末尾的 `Z` 表示 UTC 时间。

## 找到之后，用 `session_read` 读取这一轮

接着上面的例子，agent 可以调用：

```json
{
  "turnId": "turn_demo"
}
```

默认读取这一轮用户和 assistant 的正文。工具调用、工具结果和 thinking 可能很长，所以需要通过参数显式开启。

假设这轮中还发生过工具执行，但这次没有要求返回执行细节，结果会是：

```text
[path turn 1/1]
Historical Session Tree evidence; verify the current workspace when correctness depends on it.
session: session_demo; turn: turn_demo [current-session-off-path] completed
started: 2026-09-05T02:00:00.000Z; finished: 2026-09-05T02:01:00.000Z
omitted: thinking, tool calls, tool results

[user]
撤销操作后，会把之前的记录删掉吗？

[assistant]
rewind 只移动当前路径的末端，旧的 turn 和分支仍然保留，可以继续搜索和读取。
工作区文件会恢复到对应的检查点。
```

`[path turn 1/1]` 表示这次只返回了一轮。`omitted` 列出本轮存在、但按本次参数省略的内容。如果没有这类内容，就不显示这一行。

读取直接使用 Session Tree 中保存的记录，不需要搜索索引或 embedding 模型。已经知道 turn ID 时，也可以直接调用，不必先搜索。

## `session_read` 接受哪些参数

| 参数 | 类型 | 是否必填 | 默认值及含义 |
| --- | --- | --- | --- |
| `turnId` | 字符串 | 必填 | 要读取的 turn ID，也接受能唯一定位的 ID 前缀 |
| `thinking` | 布尔值 | 选填 | 默认 `false`，是否返回已保存的 thinking |
| `toolCalls` | 布尔值 | 选填 | 默认 `false`，是否返回工具名称及调用参数 |
| `toolResults` | 布尔值 | 选填 | 默认 `false`，是否返回工具结果 |
| `before` | 数字 | 选填 | 默认 0，附带目标之前的祖先 turn 数量 |
| `after` | 数字 | 选填 | 默认 0，附带目标之后的 turn 数量 |

`before` 和 `after` 都会向下取整，限制在 0–10。目标 turn 自身也会返回，因此理论上一次最多读取 21 个 turn；实际数量取决于对应路径上还有多少历史。

当前没有按 `entryId` 单独读取、按字符分页或设置返回长度的参数。开启工具结果或展开很多轮时，输出可能较长。

### 想看工具执行细节时

如果问题是“当时测试到底通过没有”，只读 assistant 的结论可能还不够。可以要求返回工具调用和结果：

```json
{
  "turnId": "turn_demo",
  "toolCalls": true,
  "toolResults": true
}
```

正文中会增加相应记录。例如，假设当时运行过测试，可能看到：

```text
[tool call bash] {"command":"bun test"}

[tool result bash] 12 pass
0 fail
```

工具实际执行记录存在时，调用参数使用实际生效的参数，并避免重复展示 assistant 消息中的同一次调用。图片位置显示为 `[image]`。

`session_search`、`session_read` 自身的调用和结果虽然不会进入搜索索引，但可以通过这两个选项读取。Compaction 的摘要和复制内容不会在这里额外展开；此前各个 turn 的原始消息仍可读取。

### 想看前后几轮时

有时候，决定是在前一轮提出、后一轮才被推翻的。可以在一次读取中附带附近的交互：

```json
{
  "turnId": "turn_on_saved_path",
  "before": 1,
  "after": 1
}
```

如果前后都存在，结果会沿对话路径，从较早的一轮依次返回三轮，分别标为 `[path turn 1/3]`、`[path turn 2/3]`、`[path turn 3/3]`。

这里的“前后”沿树中的路径计算，不是把所有 session 按时间排在一起。

目标位于它所属 session 的保存路径上时，可以沿那条路径向后展开。目标位于已离开的历史分支时，当前实现只取通向目标的祖先路径，所以 `before` 可以生效，`after` 不会继续展开该分支的后续 turn。

## 没有结果、只有部分结果和调用失败

搜索没有找到可返回的 turn 时，仍然是一次成功调用，`isError` 为 `false`。覆盖信息之后会出现：

```text
No related turns found. Try another description or a specific identifier.
```

这时可以换一种描述，或补一个更具体的路径、函数名、错误码。工具不会给出“所有匹配总数”或“每个关键词精确命中数”。

如果模型不可用但关键词搜索成功，工具也会正常返回已有结果，并在覆盖信息后增加原因，例如：

```text
Semantic recall unavailable; using keyword search: ...
```

如果 zvec 不可用，则会说明正在使用字面匹配。省略号在这里代表实际错误原因，不是固定输出。

真正的调用错误会返回 `isError: true`，`content` 是错误说明。例如读取不存在的 ID：

```json
{
  "content": "Unknown turn: turn_missing",
  "isError": true
}
```

ID 前缀同时匹配多个 turn 时，会返回 `Turn prefix is ambiguous: ...`。此时应传入更完整的 ID。查询全部为空或调用被取消，也会通过错误结果说明原因。

## 在终端里直接尝试搜索

用户也可以通过命令体验同一个搜索服务：

```text
/thread search rewind
```

需要把带空格的一句话作为一条查询时，可以使用引号：

```text
/thread search "为什么 rewind 后保留旧分支"
```

终端命令显示较短的 ID、片段类型、检索来源和覆盖情况，当前最多展示 20 个 turn。它与 agent 使用的 `session_search` 共享搜索逻辑；工具的 `limit` 参数仍然是默认 8、最多 50。

工具参数与文本格式定义在 [src/tools/session-recall.ts](../src/tools/session-recall.ts)，终端命令展示在 [src/commands/builtins.ts](../src/commands/builtins.ts)，路径展开和原文读取在 [src/session-recall/reader.ts](../src/session-recall/reader.ts)。
