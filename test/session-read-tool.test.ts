import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { SessionTreeRepository } from "../src/session-tree/repository.js";
import { SessionTreeService } from "../src/session-tree/service.js";
import { SessionRecallService } from "../src/session-recall/service.js";
import { createSessionReadTool, SESSION_READ_MAX_BYTES } from "../src/tools/session-recall.js";
import type { ToolContext } from "../src/tools/types.js";

test("session_read pages a large historical turn without losing text or splitting Unicode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "thread-read-pages-"));
  const repository = await SessionTreeRepository.open({ id: "project_test", rootPath: root, statePath: path.join(root, "state") });
  const tree = new SessionTreeService(repository);
  const recall = new SessionRecallService(tree, { semantic: false });
  try {
    await tree.initialize();
    const ancestor = await tree.startTurn("ancestor request", "ws");
    await tree.appendMessage({ turnId: ancestor.id, message: fauxAssistantMessage(fauxText("ancestor answer")) });
    await tree.finishTurn(ancestor.id, "completed");
    const turn = await tree.startTurn("inspect history", "ws");
    const originals: string[] = [];
    for (let index = 0; index < 12; index++) {
      const text = `begin-${index}\n${"历史😀".repeat(6_000)}\nend-${index}`;
      originals.push(text);
      const assistant = fauxAssistantMessage(fauxText(`step ${index}`));
      assistant.content.push({ type: "toolCall", id: `read${index}`, name: "read", arguments: { path: "file.txt" } });
      await tree.appendMessage({ turnId: turn.id, message: assistant });
      await tree.appendMessage({ turnId: turn.id, message: { role: "toolResult", toolCallId: `read${index}`, toolName: "read",
        content: [{ type: "text", text }], isError: false, timestamp: Date.now() } });
    }
    await tree.finishTurn(turn.id, "completed");
    const later = await tree.startTurn("later request", "ws");
    const laterText = "later answer: " + "中文😀".repeat(8_000);
    await tree.appendMessage({ turnId: later.id, message: fauxAssistantMessage(fauxText(laterText)) });
    await tree.finishTurn(later.id, "completed");
    const tool = createSessionReadTool(recall);
    const ctx: ToolContext = { rootPath: root, signal: new AbortController().signal,
      invocation: { executionId: "e", assistantEntryId: "a", toolCallId: "t" } };
    const narrative = await tool.execute({ turnId: turn.id }, ctx);
    assert.equal(narrative.isError, false);
    assert.match(narrative.content, /step 11/);
    assert.doesNotMatch(narrative.content, /begin-0|Continue with offset/);

    let offset = 0;
    let reconstructed = "";
    let pages = 0;
    while (true) {
      const result = await tool.execute({ turnId: turn.id, toolResults: true, before: 1, after: 1, offset }, ctx);
      assert.equal(result.isError, false, result.content);
      assert.ok(Buffer.byteLength(result.content) <= SESSION_READ_MAX_BYTES);
      assert.doesNotMatch(result.content, /\uFFFD/);
      const details = result.details as { offset: number; shownBytes: number; totalBytes: number; nextOffset?: number };
      assert.equal(details.offset, offset);
      reconstructed += Buffer.from(result.content).subarray(0, details.shownBytes).toString("utf8");
      assert.ok(++pages < 30);
      if (details.nextOffset === undefined) {
        assert.equal(Buffer.byteLength(reconstructed), details.totalBytes);
        assert.match(result.content, /End of history/);
        break;
      }
      assert.match(result.content, new RegExp(`offset=${details.nextOffset}`));
      assert.equal(details.nextOffset, offset + details.shownBytes);
      offset = details.nextOffset;
    }
    assert.ok(pages > 10);
    for (const text of originals) assert.ok(reconstructed.includes(text));
    assert.match(reconstructed, /ancestor answer/);
    assert.match(reconstructed, /\[path turn 3\/3\]/);
    assert.ok(reconstructed.endsWith(laterText));
    const largeNarrative = await tool.execute({ turnId: later.id }, ctx);
    assert.equal(largeNarrative.isError, false);
    assert.ok(Buffer.byteLength(largeNarrative.content) <= SESSION_READ_MAX_BYTES);
    assert.match(largeNarrative.content, /Continue with offset=/);
    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER]) {
      assert.equal((await tool.execute({ turnId: turn.id, offset: invalid }, ctx)).isError, true);
    }
    const insideUnicode = Buffer.from(reconstructed).indexOf(Buffer.from("历史")) + 1;
    const invalidUnicode = await tool.execute({ turnId: turn.id, toolResults: true, before: 1, after: 1, offset: insideUnicode }, ctx);
    assert.equal(invalidUnicode.isError, true);
    assert.match(invalidUnicode.content, /inside a UTF-8 character/);
    assert.equal((await tool.execute({ turnId: "missing" }, ctx)).isError, true);
  } finally {
    await recall.close();
    await repository.close();
    await rm(root, { recursive: true, force: true });
  }
});
