import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxText,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import type { ModelClient, ModelRequestOptions } from "../src/agent/model-client.js";
import { ThreadApp } from "../src/app.js";
import { loadSkills } from "../src/skills/loader.js";

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
      const treeId = app.sessionTree.tree.id;
      const firstSession = app.sessionTree.activeSession.id;
      await app.handleInput("remember alpha", { signal: new AbortController().signal });
      const beforeNew = await readFile(path.join(values.root, "seed.txt"), "utf8");

      await app.handleInput("/new", { signal: new AbortController().signal });
      const secondSession = app.sessionTree.activeSession.id;
      assert.notEqual(secondSession, firstSession);
      assert.equal(app.sessionTree.activeLiveTip, null);
      assert.deepEqual(app.sessionTree.livePath(), []);
      assert.equal(await readFile(path.join(values.root, "seed.txt"), "utf8"), beforeNew);

      await app.handleInput("fresh beta", { signal: new AbortController().signal });
      const newestContext = textFromContext(model.contexts.at(-1)!);
      assert.match(newestContext, /fresh beta/);
      assert.doesNotMatch(newestContext, /remember alpha/);

      await writeFile(path.join(values.root, "seed.txt"), "manually changed\n");
      await app.handleInput(`/session ${firstSession}`, { signal: new AbortController().signal });
      assert.equal(app.sessionTree.activeSession.id, firstSession);
      assert.equal(await readFile(path.join(values.root, "seed.txt"), "utf8"), "manually changed\n");

      await app.handleInput("/new", { signal: new AbortController().signal });
      assert.equal(app.sessionTree.projection.sessions.size, 3);
      assert.equal(app.sessionTree.tree.id, treeId);
      assert.ok([...app.sessionTree.projection.sessions.values()].every((session) => session.treeId === treeId));
    } finally {
      await app.close();
    }
  });
});

test("rewind restores the previous turn checkpoint and retains the abandoned path", async (t) => {
  const values = await fixture("thread-rewind-");
  t.after(values.cleanup);
  await writeFile(path.join(values.root, "seed.txt"), "A\n");
  await writeFile(path.join(values.root, "old.txt"), "old\n");

  await withThreadHome(values.home, async () => {
    const app = await ThreadApp.open({
      rootPath: values.root,
      model: new CapturingModel(),
      skills: { skills: [], diagnostics: [] },
    });
    try {
      await app.handleInput("first request", { signal: new AbortController().signal });
      const first = app.sessionTree.activeLiveTip!;
      await writeFile(path.join(values.root, "seed.txt"), "B\n");
      await unlink(path.join(values.root, "old.txt"));
      await writeFile(path.join(values.root, "new.txt"), "new\n");

      await app.handleInput("second request unique-needle", { signal: new AbortController().signal });
      const second = app.sessionTree.activeLiveTip!;
      await writeFile(path.join(values.root, "seed.txt"), "C\n");
      await unlink(path.join(values.root, "new.txt"));
      await writeFile(path.join(values.root, "later.txt"), "later\n");

      const candidates = app.sessionTree.rewindCandidates();
      assert.deepEqual(candidates.map((item) => item.turnId), [first, second]);
      await app.handleInput(`/rewind ${second}`, { signal: new AbortController().signal });
      assert.equal(app.sessionTree.activeLiveTip, first);
      assert.equal(await readFile(path.join(values.root, "seed.txt"), "utf8"), "A\n");
      assert.equal(await readFile(path.join(values.root, "old.txt"), "utf8"), "old\n");
      await assert.rejects(readFile(path.join(values.root, "new.txt"), "utf8"), /ENOENT/);
      await assert.rejects(readFile(path.join(values.root, "later.txt"), "utf8"), /ENOENT/);

      await app.handleInput("replacement request", { signal: new AbortController().signal });
      const replacement = app.sessionTree.activeLiveTip!;
      assert.equal(app.sessionTree.projection.turns.get(replacement)!.parentTurnId, first);
      assert.ok(app.sessionTree.projection.turns.has(second), "the abandoned turn remains factual history");
      assert.deepEqual(app.sessionTree.livePath().map((turn) => turn.id), [first, replacement]);

      const found = app.search.search(["unique-needle"]);
      assert.equal(found.hits[0]?.turnId, second);
      assert.equal(found.hits[0]?.pathStatus, "current-session-off-path");
      assert.deepEqual(await app.fsck(), []);
    } finally {
      await app.close();
    }
  });
});

test("rewind refuses a missing workspace state before moving the live tip", async (t) => {
  const values = await fixture("thread-state-integrity-");
  t.after(values.cleanup);
  await writeFile(path.join(values.root, "seed.txt"), "A\n");

  await withThreadHome(values.home, async () => {
    const app = await ThreadApp.open({
      rootPath: values.root,
      model: new CapturingModel(),
      skills: { skills: [], diagnostics: [] },
    });
    try {
      await app.handleInput("one", { signal: new AbortController().signal });
      const turnId = app.sessionTree.activeLiveTip!;
      const stateId = app.sessionTree.projection.turns.get(turnId)!.workspaceStateId;
      const statePath = path.join(app.workspaceState.repository.statesPath, `${stateId}.json`);
      await rm(statePath, { force: true });
      await assert.rejects(
        app.handleInput(`/rewind ${turnId}`, { signal: new AbortController().signal }),
        /Workspace state is missing/,
      );
      assert.equal(app.sessionTree.activeLiveTip, turnId);
    } finally {
      await app.close();
    }
  });
});

test("startup marks unfinished turns interrupted without advancing the live tip", async (t) => {
  const values = await fixture("thread-recovery-");
  t.after(values.cleanup);
  await writeFile(path.join(values.root, "seed.txt"), "A\n");

  await withThreadHome(values.home, async () => {
    const first = await ThreadApp.open({ rootPath: values.root, skills: { skills: [], diagnostics: [] } });
    const state = await first.workspaceState.capture();
    const running = await first.sessionTree.startTurn("unfinished", state.id);
    await first.close();

    const reopened = await ThreadApp.open({ rootPath: values.root, skills: { skills: [], diagnostics: [] } });
    try {
      assert.equal(reopened.sessionTree.projection.turns.get(running.id)?.status, "interrupted");
      assert.equal(reopened.sessionTree.activeLiveTip, null);
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
    const eventsPath = path.join(app.project.statePath, "session-tree", "events.jsonl");
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
