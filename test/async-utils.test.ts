import assert from "node:assert/strict";
import test from "node:test";
import { sha256, sha256Cooperative } from "../src/core/utils/id.js";

test("cooperative hashing matches the persisted SHA-256 format", async () => {
  const content = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
  assert.equal(await sha256Cooperative(content), sha256(content));
});
