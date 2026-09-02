import assert from "node:assert/strict";
import test from "node:test";
import { cooperativeSort } from "../src/utils/async.js";
import { sha256, sha256Cooperative } from "../src/utils/id.js";

test("cooperativeSort preserves comparator order across sorted runs", async () => {
  const values = ["z/3", "a/2", "a/1", "m/4", "b/5"];
  await cooperativeSort(values, (left, right) => left.localeCompare(right), 2);
  assert.deepEqual(values, ["a/1", "a/2", "b/5", "m/4", "z/3"]);
});

test("cooperative hashing matches the persisted SHA-256 format", async () => {
  const content = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
  assert.equal(await sha256Cooperative(content), sha256(content));
});
