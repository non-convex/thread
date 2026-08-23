import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ThreadApp } from "./dist/src/index.js";
import { PiModelClient } from "./dist/src/agent/model-client.js";
import { commitAll, initRepository } from "./dist/test/helpers/git-fixture.js";

// ---- 截获器：包装真实 ModelClient，把每次 stream() 收到的完整 Context 打印出来 ----
class SpyModelClient {
  constructor(inner) {
    this.inner = inner;
    this.callIndex = 0;
  }
  get modelId() { return this.inner.modelId; }
  get providerId() { return this.inner.providerId; }
  get contextWindow() { return this.inner.contextWindow; }
  get maxOutputTokens() { return this.inner.maxOutputTokens; }

  async stream(context, options) {
    this.callIndex += 1;
    console.log(`\n${"=".repeat(78)}`);
    console.log(`>>> 第 ${this.callIndex} 次模型调用 —— 完整 Context（即发给模型的全部输入）`);
    console.log(`${"=".repeat(78)}`);
    dumpContext(context);
    return this.inner.stream(context, options);
  }
  async completeText(systemPrompt, prompt, options) {
    return this.inner.completeText(systemPrompt, prompt, options);
  }
}

function dumpValue(value, indent) {
  const pad = " ".repeat(indent);
  if (typeof value === "string") {
    if (value.includes("\n")) {
      console.log(`${pad}"""`);
      for (const line of value.split("\n")) console.log(`${pad}  ${line}`);
      console.log(`${pad}"""`);
    } else {
      console.log(`${pad}${JSON.stringify(value)}`);
    }
  } else {
    console.log(pad + JSON.stringify(value, null, 2).replace(/\n/g, "\n" + pad));
  }
}

function dumpContext(context) {
  console.log(`\n┌─ systemPrompt ${"─".repeat(62)}`);
  dumpValue(context.systemPrompt, 2);

  console.log(`\n├─ tools（共 ${context.tools.length} 个，来自 ToolRegistry.modelDefinitions()）${"─".repeat(18)}`);
  for (const tool of context.tools) {
    console.log(`│  • ${tool.name}: ${tool.description}`);
    console.log(`│    parameters: ${JSON.stringify(tool.parameters)}`);
  }

  console.log(`\n└─ messages（共 ${context.messages.length} 条）${"─".repeat(55)}`);
  context.messages.forEach((message, index) => {
    const tag = message.isError ? "  [isError]" : "";
    console.log(`\n  [${index}] role=${message.role}${tag}`);
    if (typeof message.content === "string") {
      console.log(`      content: ${JSON.stringify(message.content)}`);
    } else {
      for (const block of message.content) {
        if (block.type === "text") {
          console.log(`      ├ text: ${JSON.stringify(block.text.slice(0, 300))}${block.text.length > 300 ? "…" : ""}`);
        } else if (block.type === "toolCall") {
          console.log(`      ├ toolCall: id=${block.id} name=${block.name}`);
          console.log(`      │   arguments: ${JSON.stringify(block.arguments)}`);
        } else {
          console.log(`      ├ ${block.type}: ${JSON.stringify(block).slice(0, 200)}`);
        }
      }
    }
    if (message.role === "assistant") {
      console.log(`      └ stopReason=${message.stopReason}  usage=${JSON.stringify(message.usage)}`);
    }
  });
}

// ---- 搭建真实 workspace ----
const fixture = await mkdtemp(path.join(tmpdir(), "thread-context-demo-"));
const root = path.join(fixture, "project");
await initRepository(root);
await writeFile(path.join(root, ".gitignore"), ".thread/\n");
await writeFile(
  path.join(root, "main.py"),
  'def greet(name):\n    return f"Hello, {name}"  # 期望中英文双语\n\nprint(greet("世界"))\n',
);
await commitAll(root, "seed");

// ---- 脚本化模型：read → edit → 总结，模拟一次真实修复会话 ----
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("read", { path: "main.py" }), { stopReason: "toolUse" }),
  fauxAssistantMessage(
    fauxToolCall("edit", {
      path: "main.py",
      oldText: 'return f"Hello, {name}"  # 期望中英文双语',
      newText: 'return f"Hello, {name}! 你好, {name}!"',
    }),
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("已修复：greet 现在同时输出英文和中文问候。"),
]);

const model = new SpyModelClient(new PiModelClient(models, faux.getModel()));
const app = await ThreadApp.open({ rootPath: root, model });
try {
  const signal = new AbortController().signal;
  const result = await app.handleInput("修复 main.py 里的问候语 bug", { signal });
  console.log(`\n${"=".repeat(78)}`);
  console.log(`turn 结果: ${result.kind === "turn" ? result.result.outcome : result.kind}`);
} finally {
  await app.close();
  await rm(fixture, { recursive: true, force: true });
}
