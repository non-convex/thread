import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { PiModelClient, type ModelClient, type ModelRequestOptions } from "../../src/agent/model-client.js";
import { ThreadApp } from "../../src/app.js";
import { buildHistoryItems, buildSquashItems } from "../../src/commands/builtins.js";
import type { Turn } from "../../src/domain.js";
import type { UiEvent } from "../../src/ui/events.js";
import { projectTranscript } from "../../src/ui/terminal/transcript-projection.js";
import { commitAll, initRepository } from "../helpers/git-fixture.js";

class ThresholdModel implements ModelClient {
  readonly modelId = "threshold";
  readonly providerId = "test";
  readonly contextWindow = 128_000;
  readonly maxOutputTokens = 4_000;
  streamCalls = 0;
  forkCalls = 0;

  async stream(_context: Context): Promise<AssistantMessage> {
    this.streamCalls++;
    return fauxAssistantMessage(this.streamCalls === 1 ? "x".repeat(420_000) : `reply ${this.streamCalls}`);
  }

  async completeText(): Promise<string> {
    throw new Error("not used");
  }

  async forkComplete(_context: Context, instruction: string, _options: ModelRequestOptions): Promise<string> {
    this.forkCalls++;
    assert.match(instruction, /Do not call or request any tool/i);
    return "automatic project summary";
  }
}

class StaleForkModel implements ModelClient {
  readonly modelId = "stale-fork";
  readonly providerId = "test";
  readonly contextWindow = 128_000;
  readonly maxOutputTokens = 4_000;
  onFork: (() => Promise<void>) | undefined;

  async stream(): Promise<AssistantMessage> {
    return fauxAssistantMessage("ordinary reply");
  }

  async completeText(): Promise<string> {
    throw new Error("not used");
  }

  async forkComplete(): Promise<string> {
    await this.onFork?.();
    return "stale summary";
  }
}

test("manual compact creates a root squash and thread squash runs as a rewindable prepared turn", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-squash-flow-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, ".gitignore"), ".thread/\n");
  await writeFile(path.join(root, "seed.txt"), "seed\n");
  await commitAll(root, "seed");

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage("reply 1"),
    fauxAssistantMessage("reply 2"),
    fauxAssistantMessage("reply 3"),
    fauxAssistantMessage("reply 4"),
    fauxAssistantMessage("root project summary"),
    fauxAssistantMessage("reply 5"),
    fauxAssistantMessage("reply 6"),
    fauxAssistantMessage("reply 7"),
    fauxAssistantMessage("incremental summary"),
    fauxAssistantMessage("continued after squash"),
  ]);
  const app = await ThreadApp.open({ rootPath: root, model: new PiModelClient(models, faux.getModel()) });
  t.after(() => app.close());
  const signal = new AbortController().signal;

  for (let turn = 1; turn <= 4; turn++) await app.handleInput(`request ${turn}`, { signal });
  const oldCheckpoint = app.versions.head;
  const oldLeaf = oldCheckpoint.sessionHeadId!;
  const keepBefore = await app.versions.workspace.readKeepRef();
  const workspace = app.versions.workspace;
  const originalCapture = workspace.capture;
  const originalRestoreTree = workspace.restoreTree;
  const originalUpdateKeepRef = workspace.updateKeepRef;
  let captureCalls = 0;
  let restoreCalls = 0;
  let keepRefUpdates = 0;
  workspace.capture = async (...args: Parameters<typeof workspace.capture>) => {
    captureCalls++;
    return originalCapture.call(workspace, ...args);
  };
  workspace.restoreTree = async (...args: Parameters<typeof workspace.restoreTree>) => {
    restoreCalls++;
    return originalRestoreTree.call(workspace, ...args);
  };
  workspace.updateKeepRef = async (...args: Parameters<typeof workspace.updateKeepRef>) => {
    keepRefUpdates++;
    return originalUpdateKeepRef.call(workspace, ...args);
  };
  const compact = await app.handleInput("/compact", { signal });
  workspace.capture = originalCapture;
  workspace.restoreTree = originalRestoreTree;
  workspace.updateKeepRef = originalUpdateKeepRef;
  assert.equal(compact.kind, "command");
  const rootSquash = app.session.projection.entries.get(app.versions.head.sessionHeadId!)!;
  assert.equal(rootSquash.type, "squash");
  if (rootSquash.type !== "squash") assert.fail("expected root squash");
  assert.equal(rootSquash.parentId, null);
  assert.equal(rootSquash.summaryKind, "project_state");
  assert.equal(rootSquash.summary, "root project summary");
  assert.equal(app.session.pathTo(rootSquash.id).length, 1);
  assert.equal(app.versions.head.reason, "squash");
  assert.deepEqual(app.versions.head.parentCheckpointIds, [oldCheckpoint.id]);
  assert.equal(app.versions.head.workspaceTreeOid, oldCheckpoint.workspaceTreeOid);
  assert.equal(app.versions.head.retentionCommitOid, oldCheckpoint.retentionCommitOid);
  assert.equal(app.versions.head.details?.squashSourceHeadId, oldLeaf);
  assert.equal(await app.versions.workspace.readKeepRef(), keepBefore, "pure squash must not move the keep ref");
  assert.deepEqual(
    { captureCalls, restoreCalls, keepRefUpdates },
    { captureCalls: 0, restoreCalls: 0, keepRefUpdates: 0 },
    "pure squash reuses the parent snapshot without sidecar mutation",
  );

  const retainedHistory = buildHistoryItems({
    rootPath: root,
    versions: app.versions,
    merge: app.merge,
    capsules: app.capsules,
    model: app.model,
    signal,
  });
  assert.ok(retainedHistory.length > 0);
  assert.ok(retainedHistory.some((item) => item.status === "retained"));
  assert.ok(retainedHistory.some((item) => item.status === "off-path"));

  const laterTurns: Turn[] = [];
  for (let turn = 5; turn <= 7; turn++) {
    const result = await app.handleInput(`request ${turn}`, { signal });
    assert.equal(result.kind, "turn");
    if (result.kind === "turn") laterTurns.push(result.result.turn);
  }
  const selected = laterTurns[1]!;
  const selectedEntry = app.session.projection.entries.get(selected.userEntryId)!;
  const selectedParentId = selectedEntry.parentId;
  const sourceHeadId = app.versions.head.sessionHeadId!;
  const picker = await app.handleInput("/thread squash", { signal });
  assert.equal(picker.kind, "command");
  if (picker.kind !== "command" || picker.result.view?.type !== "thread_squash") {
    assert.fail("expected thread squash picker");
  }
  assert.deepEqual(
    picker.result.view.items.map((item) => item.label),
    ["request 7", "request 6", "request 5"],
    "retained turns are not structural squash targets",
  );

  const uiEvents: UiEvent[] = [];
  const squashed = await app.handleInput(`/thread squash ${selected.id}`, {
    signal,
    onUiEvent: (event) => uiEvents.push(event),
  });
  assert.equal(squashed.kind, "turn");
  if (squashed.kind !== "turn") assert.fail("expected synthetic squash turn");
  assert.equal(squashed.result.outcome, "completed");
  const syntheticEntry = app.session.projection.entries.get(squashed.result.turn.userEntryId)!;
  assert.equal(syntheticEntry.type, "squash");
  if (syntheticEntry.type !== "squash") assert.fail("expected incremental squash");
  assert.equal(syntheticEntry.summaryKind, "incremental");
  assert.equal(syntheticEntry.parentId, selectedParentId);
  assert.equal(syntheticEntry.summary, "incremental summary");
  const liveStart = uiEvents.find((event) => event.type === "turn_started");
  assert.equal(liveStart?.type === "turn_started" ? liveStart.userEntryId : undefined, syntheticEntry.id);
  assert.equal(liveStart?.type === "turn_started" ? liveStart.syntheticSquash : undefined, true);
  const committedTranscript = projectTranscript(
    app.session.pathTo(app.versions.head.sessionHeadId),
    app.session.projection.records.filter((record) => record.type === "tool_started"),
  );
  assert.equal(
    committedTranscript.filter((item) => item.id === syntheticEntry.id).length,
    1,
    "the live squash identity resolves to exactly one committed transcript item",
  );
  assert.equal(squashed.result.turn.baseCheckpointId.length > 0, true);
  const resultCheckpoint = app.versions.getCheckpoint(squashed.result.turn.resultCheckpointId!);
  const squashCheckpoint = app.versions.getCheckpoint(resultCheckpoint.parentCheckpointIds[0]!);
  assert.equal(squashCheckpoint.reason, "squash");
  assert.deepEqual(squashCheckpoint.parentCheckpointIds, [squashed.result.turn.baseCheckpointId]);
  assert.equal(squashCheckpoint.details?.squashFromEntryId, selected.userEntryId);
  assert.equal(squashCheckpoint.details?.squashSourceHeadId, sourceHeadId);

  const commandContext = {
    rootPath: root,
    versions: app.versions,
    merge: app.merge,
    capsules: app.capsules,
    model: app.model,
    signal,
  };
  assert.equal(buildHistoryItems(commandContext)[0]!.status, "synthetic-squash");
  assert.ok(buildSquashItems(commandContext).every((item) => item.status === "current-path"));
  const abandoned = buildHistoryItems(commandContext).find((item) => item.turnId === laterTurns[2]!.id);
  assert.equal(abandoned?.status, "off-path", "the replaced same-branch tail is not mistaken for retained context");
  await assert.rejects(
    app.handleInput(`/thread squash ${laterTurns[2]!.id}`, { signal }),
    /current-path user turn/,
  );

  await app.versions.restoreTurnBefore(squashed.result.turn.id);
  assert.equal(app.versions.head.sessionHeadId, sourceHeadId, "rewind restores the pre-squash entry path");
  assert.ok(app.session.pathTo(app.versions.head.sessionHeadId).some((entry) => entry.id === selected.userEntryId));
});

test("threshold squash runs inside the open turn without nesting an operation", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-auto-squash-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, ".gitignore"), ".thread/\n");
  await commitAll(root, "seed");
  const model = new ThresholdModel();
  const app = await ThreadApp.open({ rootPath: root, model });
  t.after(() => app.close());
  const signal = new AbortController().signal;

  await app.handleInput("large first turn", { signal });
  await app.handleInput("second turn", { signal });
  const third = await app.handleInput("third turn", { signal });
  assert.equal(third.kind, "turn");
  assert.equal(model.forkCalls, 1);
  const squashCheckpoints = [...app.session.projection.checkpoints.values()].filter(
    (checkpoint) => checkpoint.reason === "squash" && checkpoint.details?.squashTrigger === "threshold",
  );
  assert.equal(squashCheckpoints.length, 1);
  const squash = app.session.projection.entries.get(squashCheckpoints[0]!.sessionHeadId!)!;
  assert.equal(squash.type, "squash");
  if (squash.type !== "squash") assert.fail("expected automatic root squash");
  assert.equal(squash.parentId, null);
  assert.ok(squash.retainedTail.some((item) =>
    item.message.role === "user" && item.message.content === "third turn"
  ));
  assert.equal(
    squashCheckpoints[0]!.details?.squashSourceHeadId,
    third.kind === "turn" ? third.result.turn.userEntryId : undefined,
    "automatic squash records the real lane leaf, which is ahead of the turn-base checkpoint",
  );
  const thirdHistory = buildHistoryItems({
    rootPath: root,
    versions: app.versions,
    merge: app.merge,
    capsules: app.capsules,
    model: app.model,
    signal,
  }).find((item) => item.turnId === (third.kind === "turn" ? third.result.turn.id : ""));
  assert.equal(thirdHistory?.status, "retained");
  const runStarts = app.session.projection.records.filter((record) => record.type === "operation_started");
  assert.equal(runStarts.length, 3, "each user turn has exactly one run operation");
  assert.ok(runStarts.every((record) => record.intent.kind === "run"), "automatic squash creates no nested operation");
  assert.equal(app.session.projection.getOpenOperations().length, 0);
});

test("squashing an older branch cannot move the global retention tip backward", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-squash-retention-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, ".gitignore"), ".thread/\n");
  await commitAll(root, "seed");
  const app = await ThreadApp.open({ rootPath: root });
  t.after(() => app.close());

  await assert.rejects(
    app.handleInput("/thread commit unavailable", { signal: new AbortController().signal }),
    /requires a configured model/,
  );

  const genesis = app.versions.head;
  await app.versions.createBranch("old", "HEAD", false);
  await writeFile(path.join(root, "newer.txt"), "newer\n");
  const newer = await app.versions.syncCurrentWorkspace("command", true);
  const globalTip = app.versions.expectedKeepRef!;
  assert.notEqual(globalTip, genesis.retentionCommitOid);
  assert.equal(await app.versions.workspace.readKeepRef(), globalTip);

  await app.versions.switchBranch("old");
  const squash = await app.session.appendEntryAt(
    "old",
    null,
    {
      id: `entry_${crypto.randomUUID().replaceAll("-", "")}`,
      sessionId: app.session.store.sessionId,
      type: "squash",
      summaryKind: "project_state",
      summary: "old branch state",
      workspaceDiffStat: "total: 0 file(s), +0 -0, 0 binary",
      retainedTail: [],
      requestTokensBefore: 0,
    },
    { expectedLeafId: null, flush: true },
  );
  await app.versions.persistSquashCheckpoint({
    branchName: "old",
    expectedHeadCheckpointId: genesis.id,
    sessionHeadId: squash.id,
    details: {
      squashFromEntryId: null,
      squashSourceHeadId: null,
      squashTrigger: "compact_command",
      squashEntryCount: 0,
      squashTurnCount: 0,
    },
  });
  assert.equal(app.versions.expectedKeepRef, globalTip);
  assert.equal(await app.versions.workspace.readKeepRef(), globalTip);
  await app.versions.workspace.verifySnapshot(newer.workspaceTreeOid, newer.retentionCommitOid);
  assert.deepEqual(await app.fsck(), []);
});

test("thread squash discards a summary when the checkpoint changes during its fork", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-squash-stale-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, ".gitignore"), ".thread/\n");
  await commitAll(root, "seed");
  const model = new StaleForkModel();
  const app = await ThreadApp.open({ rootPath: root, model });
  t.after(() => app.close());
  const signal = new AbortController().signal;
  const first = await app.handleInput("first request", { signal });
  assert.equal(first.kind, "turn");
  if (first.kind !== "turn") assert.fail("expected a turn");
  model.onFork = () => app.versions.syncCurrentWorkspace("command", true).then(() => undefined);

  await assert.rejects(
    app.handleInput(`/thread squash ${first.result.turn.id}`, { signal }),
    /checkpoint changed while generating squash summary/,
  );
  assert.equal(
    [...app.session.projection.entries.values()].filter((entry) => entry.type === "squash").length,
    0,
  );
  assert.equal(app.session.projection.getOpenOperations().length, 0);
});

test("startup recovery attaches a durable squash leaf whose checkpoint batch was interrupted", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "thread-squash-recovery-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, "project");
  await initRepository(root);
  await writeFile(path.join(root, ".gitignore"), ".thread/\n");
  await commitAll(root, "seed");

  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage("reply 1"),
    fauxAssistantMessage("reply 2"),
    fauxAssistantMessage("reply 3"),
    fauxAssistantMessage("recoverable summary"),
  ]);
  let app = await ThreadApp.open({ rootPath: root, model: new PiModelClient(models, faux.getModel()) });
  t.after(() => app.close());
  const signal = new AbortController().signal;
  for (let turn = 1; turn <= 3; turn++) await app.handleInput(`request ${turn}`, { signal });
  app.versions.finishCompaction = async () => {
    throw new Error("simulated checkpoint interruption");
  };
  await assert.rejects(app.handleInput("/compact", { signal }), /simulated checkpoint interruption/);
  const interruptedLeaf = app.session.projection.lanes.get("main")!;
  assert.equal(app.session.projection.entries.get(interruptedLeaf)?.type, "squash");
  assert.equal(app.session.projection.getOpenOperations().length, 1);
  await app.close();

  app = await ThreadApp.open({ rootPath: root });
  assert.equal(app.versions.head.reason, "recovery");
  assert.equal(app.versions.head.sessionHeadId, interruptedLeaf);
  assert.equal(app.session.projection.getOpenOperations().length, 0);
  assert.deepEqual(await app.fsck(), []);
});
