import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { PiModelClient } from "../src/agent/model-client.js";
import { ThreadApp } from "../src/app.js";
import { loadSkills } from "../src/skills/loader.js";
import { runGit } from "../src/workspace/git.js";

async function initRepository(rootPath: string): Promise<void> {
  await mkdir(rootPath, { recursive: true });
  await runGit(["init", "--initial-branch=main", rootPath]);
  await runGit(["-C", rootPath, "config", "user.name", "thread test"]);
  await runGit(["-C", rootPath, "config", "user.email", "thread@test.local"]);
  await writeFile(path.join(rootPath, "seed.txt"), "seed\n");
  await runGit(["-C", rootPath, "add", "-A"]);
  await runGit(["-C", rootPath, "commit", "-m", "seed"]);
}

async function removeFixture(fixturePath: string, attempts = 5): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await rm(fixturePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === attempts || (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM")) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
}

test("thread commit and show use the full request context cost", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-context-cost-"));
  t.after(() => removeFixture(fixture));
  const rootPath = path.join(fixture, "project");
  await initRepository(rootPath);

  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxText("capsule"))]);
  const models = createModels();
  models.setProvider(faux.provider);
  const app = await ThreadApp.open({
    rootPath,
    model: new PiModelClient(models, faux.getModel()),
    skills: { skills: [], diagnostics: [] },
  });

  try {
    const expected = app.contextOccupancy(app.versions.head.sessionHeadId);
    assert.ok(expected && expected.requestTokens > 0, "the system prompt and tools occupy context before any turn");

    const committed = await app.handleInput("/thread commit baseline", { signal: new AbortController().signal });
    assert.equal(committed.kind, "command");
    const commit = [...app.versions.projection.commits.values()].at(-1);
    assert.ok(commit);
    assert.equal(commit.contextCost.estimatedTokens, expected.requestTokens);
    assert.equal(commit.contextCost.percent, expected.percent);

    const shown = await app.handleInput("/thread show HEAD", { signal: new AbortController().signal });
    assert.equal(shown.kind, "command");
    const details = JSON.parse(shown.result.content) as { currentModelContextCost: typeof commit.contextCost };
    assert.deepEqual(details.currentModelContextCost, commit.contextCost);
  } finally {
    await app.close();
  }
});

test("standalone skill files use their filename as the skill name", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-single-skill-"));
  t.after(() => removeFixture(fixture));
  await writeFile(
    path.join(fixture, "release-notes.md"),
    "---\nname: release-notes\ndescription: Prepare release notes.\n---\n\nWrite concise notes.\n",
  );
  await writeFile(
    path.join(fixture, "triage.md"),
    "---\ndescription: Triage a reported problem.\n---\n\nFind the smallest reproduction.\n",
  );

  const loaded = await loadSkills(fixture);
  assert.deepEqual(loaded.skills.map((skill) => skill.name), ["release-notes", "triage"]);
  assert.deepEqual(loaded.diagnostics, []);
});
