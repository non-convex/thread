import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import type { ModelClient, ModelRequestOptions } from "../src/core/agent/model-client.js";
import { ThreadApp } from "../src/app/thread-app.js";
import { loadSkills } from "../src/core/skills/loader.js";

class CapturingModel implements ModelClient {
  readonly modelId = "capture";
  readonly providerId = "test";
  readonly contextWindow = 128_000;
  readonly maxOutputTokens = 8_192;
  readonly reasoning = false;
  readonly contexts: Context[] = [];
  private response = 0;

  async stream(context: Context, _options: ModelRequestOptions): Promise<AssistantMessage> {
    this.contexts.push(structuredClone(context));
    return fauxAssistantMessage(fauxText(`response ${++this.response}`));
  }

  async completeText(_systemPrompt: string, _prompt: string, _options: ModelRequestOptions): Promise<string> {
    return "summary";
  }

  async forkComplete(_context: Context, _instruction: string, _options: ModelRequestOptions): Promise<string> {
    return "summary";
  }
}

class EditingModel extends CapturingModel {
  override async stream(context: Context, options: ModelRequestOptions): Promise<AssistantMessage> {
    const last = context.messages.at(-1);
    if (last?.role === "user" && typeof last.content === "string") {
      if (last.content === "first request" || last.content === "one") {
        return fauxAssistantMessage(fauxToolCall("write", { path: "seed.txt", content: "B\n" }, { id: "write-seed" }), { stopReason: "toolUse" });
      }
      if (last.content === "second request unique-needle") {
        return fauxAssistantMessage([
          fauxToolCall("write", { path: "seed.txt", content: "C\n" }, { id: "write-next" }),
          fauxToolCall("write", { path: "new.txt", content: "new\n" }, { id: "write-new" }),
        ], { stopReason: "toolUse" });
      }
    }
    return super.stream(context, options);
  }
}

async function fixture(prefix: string): Promise<{ root: string; home: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const root = path.join(directory, "project");
  const home = path.join(directory, "thread-home");
  await mkdir(root, { recursive: true });
  await mkdir(home, { recursive: true });
  return {
    root,
    home,
    cleanup: () => rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}

async function withThreadHome<T>(home: string, operation: () => Promise<T>): Promise<T> {
  const before = process.env.THREAD_HOME;
  process.env.THREAD_HOME = home;
  try {
    return await operation();
  } finally {
    if (before === undefined) delete process.env.THREAD_HOME;
    else process.env.THREAD_HOME = before;
  }
}

function textFromContext(context: Context): string {
  return context.messages.map((message) => {
    if (typeof message.content === "string") return message.content;
    return message.content.map((block) => block.type === "text" ? block.text : "").join("\n");
  }).join("\n");
}

test("non-Git projects use one persistent Session Tree and /new creates empty root Sessions", async (t) => {
  const values = await fixture("thread-session-tree-");
  t.after(values.cleanup);
  await writeFile(path.join(values.root, "seed.txt"), "unchanged\n");

  await withThreadHome(values.home, async () => {
    const model = new CapturingModel();
    const app = await ThreadApp.open({ rootPath: values.root, model, skills: { skills: [], diagnostics: [] } });
    try {
      const treeId = app.runtime["tree"].tree.id;
      const firstSession = app.selectedSessionId;
      await app.handleInput("remember alpha", { signal: new AbortController().signal });
      const beforeNew = await readFile(path.join(values.root, "seed.txt"), "utf8");

      await app.handleInput("/new", { signal: new AbortController().signal });
      const secondSession = app.selectedSessionId;
      assert.notEqual(secondSession, firstSession);
      assert.equal(app.runtime["tree"].activeLiveTip, null);
      assert.deepEqual(app.runtime["tree"].livePath(), []);
      assert.equal(await readFile(path.join(values.root, "seed.txt"), "utf8"), beforeNew);

      await app.handleInput("fresh beta", { signal: new AbortController().signal });
      const newestContext = textFromContext(model.contexts.at(-1)!);
      assert.match(newestContext, /fresh beta/);
      assert.doesNotMatch(newestContext, /remember alpha/);

      await writeFile(path.join(values.root, "seed.txt"), "manually changed\n");
      await app.handleInput(`/session ${firstSession}`, { signal: new AbortController().signal });
      assert.equal(app.selectedSessionId, firstSession);
      assert.equal(await readFile(path.join(values.root, "seed.txt"), "utf8"), "manually changed\n");

      await app.handleInput("/new", { signal: new AbortController().signal });
      assert.equal(app.runtime["tree"].projection.sessions.size, 3);
      assert.equal(app.runtime["tree"].tree.id, treeId);
      assert.ok([...app.runtime["tree"].projection.sessions.values()].every((session) => session.treeId === treeId));
    } finally {
      await app.close();
    }
  });
});

test("rewind restores tracked edits and retains the abandoned path", async (t) => {
  const values = await fixture("thread-rewind-");
  t.after(values.cleanup);
  await writeFile(path.join(values.root, "seed.txt"), "A\n");
  await writeFile(path.join(values.root, "old.txt"), "old\n");

  await withThreadHome(values.home, async () => {
    const app = await ThreadApp.open({
      rootPath: values.root,
      search: { semantic: false },
      model: new EditingModel(),
      tools: ["write"],
      fileCheckpoints: true,
      skills: { skills: [], diagnostics: [] },
    });
    try {
      await app.handleInput("first request", { signal: new AbortController().signal });
      const first = app.runtime["tree"].activeLiveTip!;
      await unlink(path.join(values.root, "old.txt"));

      await app.handleInput("second request unique-needle", { signal: new AbortController().signal });
      const second = app.runtime["tree"].activeLiveTip!;
      await writeFile(path.join(values.root, "seed.txt"), "C\n");
      await unlink(path.join(values.root, "new.txt"));
      await writeFile(path.join(values.root, "later.txt"), "later\n");

      const candidates = app.runtime["tree"].rewindCandidates();
      assert.deepEqual(candidates.map((item) => item.turnId), [first, second]);
      await app.handleInput(`/rewind ${second}`, { signal: new AbortController().signal });
      assert.equal(app.runtime["tree"].activeLiveTip, first);
      assert.equal(await readFile(path.join(values.root, "seed.txt"), "utf8"), "B\n");
      await assert.rejects(readFile(path.join(values.root, "old.txt")), /ENOENT/);
      await assert.rejects(readFile(path.join(values.root, "new.txt"), "utf8"), /ENOENT/);
      assert.equal(await readFile(path.join(values.root, "later.txt"), "utf8"), "later\n");

      await app.handleInput("replacement request", { signal: new AbortController().signal });
      const replacement = app.runtime["tree"].activeLiveTip!;
      assert.equal(app.runtime["tree"].projection.turns.get(replacement)!.parentTurnId, first);
      assert.ok(app.runtime["tree"].projection.turns.has(second), "the abandoned turn remains factual history");
      assert.deepEqual(app.runtime["tree"].livePath().map((turn) => turn.id), [first, replacement]);

      const found = await app.runtime.searchHistory(["unique-needle"]);
      assert.equal(found.hits[0]?.turnId, second);
      assert.equal(found.hits[0]?.pathStatus, "current-session-off-path");
      assert.deepEqual(await app.runtime.fsck(), []);
    } finally {
      await app.close();
    }
  });
});

test("rewind refuses a missing file backup before moving the live tip", async (t) => {
  const values = await fixture("thread-state-integrity-");
  t.after(values.cleanup);
  await writeFile(path.join(values.root, "seed.txt"), "A\n");

  await withThreadHome(values.home, async () => {
    const app = await ThreadApp.open({
      rootPath: values.root,
      model: new EditingModel(),
      tools: ["write"],
      fileCheckpoints: true,
      skills: { skills: [], diagnostics: [] },
    });
    try {
      await app.handleInput("one", { signal: new AbortController().signal });
      const turnId = app.runtime["tree"].activeLiveTip!;
      const edit = app.runtime["tree"].entriesForTurn(turnId).find((entry) => entry.type === "file_edit");
      assert.ok(edit?.type === "file_edit" && edit.before);
      await rm(app.runtime["files"].store.blobPath(edit.before.blobId), { force: true });
      await assert.rejects(
        app.handleInput(`/rewind ${turnId}`, { signal: new AbortController().signal }),
        /ENOENT/,
      );
      assert.equal(app.runtime["tree"].activeLiveTip, turnId);
    } finally {
      await app.close();
    }
  });
});

test("startup seals unfinished turns as interrupted live tips", async (t) => {
  const values = await fixture("thread-recovery-");
  t.after(values.cleanup);
  await writeFile(path.join(values.root, "seed.txt"), "A\n");

  await withThreadHome(values.home, async () => {
    const first = await ThreadApp.open({ rootPath: values.root, skills: { skills: [], diagnostics: [] } });
    const running = await first.runtime["tree"].startTurn("unfinished");
    await first.close();

    const reopened = await ThreadApp.open({ rootPath: values.root, skills: { skills: [], diagnostics: [] } });
    try {
      assert.equal(reopened.runtime["tree"].projection.turns.get(running.id)?.status, "interrupted");
      assert.equal(reopened.runtime["tree"].activeLiveTip, running.id);
      const roles = reopened.runtime["tree"].messagesForTurn(running.id).map((message) => message.role);
      assert.deepEqual(roles, ["user", "assistant"]);
    } finally {
      await reopened.close();
    }
  });
});

test("old Session Tree records are rejected instead of migrated", async (t) => {
  const values = await fixture("thread-old-data-");
  t.after(values.cleanup);

  await withThreadHome(values.home, async () => {
    const app = await ThreadApp.open({ rootPath: values.root, skills: { skills: [], diagnostics: [] } });
    const eventsPath = path.join(app.runtime.project.statePath, "session-tree", "events.jsonl");
    await app.close();
    await writeFile(eventsPath, `${JSON.stringify({ seq: 1, timestamp: Date.now(), type: "tree_created", tree: { formatVersion: 3 } })}\n`);
    await assert.rejects(
      ThreadApp.open({ rootPath: values.root, skills: { skills: [], diagnostics: [] } }),
      /Expected Session Tree record|unsupported|old Thread data/i,
    );
  });
});

test("standalone skill files use their filename as the skill name", async (t) => {
  const values = await fixture("thread-single-skill-");
  t.after(values.cleanup);
  await writeFile(
    path.join(values.root, "release-notes.md"),
    "---\nname: release-notes\ndescription: Prepare release notes.\n---\n\nWrite concise notes.\n",
  );
  await writeFile(
    path.join(values.root, "triage.md"),
    "---\ndescription: Triage a reported problem.\n---\n\nFind the smallest reproduction.\n",
  );

  const loaded = await loadSkills(values.root);
  assert.deepEqual(loaded.skills.map((skill) => skill.name), ["release-notes", "triage"]);
  assert.deepEqual(loaded.diagnostics, []);
});
