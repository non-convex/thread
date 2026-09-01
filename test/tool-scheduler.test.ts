import assert from "node:assert/strict";
import test from "node:test";
import { ToolScheduler, resourceClaimsConflict } from "../src/agent/tool-scheduler.js";
import { claim } from "../src/tools/execution.js";

function gate(): { promise: Promise<void>; release(): void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("resource claims distinguish read sharing, write conflicts, subtrees, and workspace wildcards", () => {
  const file = claim("workspace", "/work/src/a.ts", "read");
  const sameRead = claim("workspace", "/work/src/a.ts", "read");
  const sameWrite = claim("workspace", "/work/src/a.ts", "write");
  const directoryWrite = claim("workspace", "/work/src", "write", "subtree");
  const otherFileWrite = claim("workspace", "/work/test/b.ts", "write");
  const wildcard = claim("workspace", "*", "write", "subtree");

  assert.equal(resourceClaimsConflict([file], [sameRead]), false);
  assert.equal(resourceClaimsConflict([file], [sameWrite]), true);
  assert.equal(resourceClaimsConflict([file], [directoryWrite]), true);
  assert.equal(resourceClaimsConflict([file], [otherFileWrite]), false);
  assert.equal(resourceClaimsConflict([file], [wildcard]), true);
});

test("different write resources run concurrently while a sequential call forms a source-order barrier", async () => {
  const scheduler = new ToolScheduler<string>(new AbortController().signal);
  const first = gate();
  const second = gate();
  const sequential = gate();
  const starts: string[] = [];

  const firstResult = scheduler.schedule({
    id: "first",
    mode: "parallel",
    eager: false,
    resources: [claim("workspace", "/work/a", "write")],
    run: async () => {
      starts.push("first");
      await first.promise;
      return "first";
    },
  });
  const secondResult = scheduler.schedule({
    id: "second",
    mode: "parallel",
    eager: false,
    resources: [claim("workspace", "/work/b", "write")],
    run: async () => {
      starts.push("second");
      await second.promise;
      return "second";
    },
  });
  const sequentialResult = scheduler.schedule({
    id: "sequential",
    mode: "sequential",
    eager: true,
    resources: [],
    run: async () => {
      starts.push("sequential");
      await sequential.promise;
      return "sequential";
    },
  });
  const afterResult = scheduler.schedule({
    id: "after",
    mode: "parallel",
    eager: true,
    resources: [],
    run: async () => {
      starts.push("after");
      return "after";
    },
  });

  await Promise.resolve();
  assert.deepEqual(starts, []);
  scheduler.releaseResponse();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(new Set(starts), new Set(["first", "second"]));

  first.release();
  second.release();
  assert.deepEqual(await Promise.all([firstResult, secondResult]), ["first", "second"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(starts.slice(2), ["sequential"]);

  sequential.release();
  assert.equal(await sequentialResult, "sequential");
  assert.equal(await afterResult, "after");
  assert.deepEqual(starts.slice(2), ["sequential", "after"]);
});
