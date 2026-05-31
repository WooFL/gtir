import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkRecursive, stableId } from "../src/chunker.mjs";

const cfg = { maxChars: 120, minChars: 20, overlapChars: 30 };

test("chunkRecursive splits a long file into multiple overlapping chunks", () => {
  const text = Array.from({ length: 20 }, (_, i) => `line number ${i} of text`).join("\n");
  const chunks = chunkRecursive("f.txt", "text", text, cfg);
  assert.ok(chunks.length >= 2, "expected multiple chunks");
  for (const c of chunks) assert.ok(c.text.length >= cfg.minChars);
  assert.equal(chunks[0].path, "f.txt");
  assert.equal(chunks[0].lineStart, 1);
});

test("stableId is deterministic and changes with text", () => {
  const a = { path: "f.txt", chunkStart: 0, chunkEnd: 5, text: "hello" };
  const b = { path: "f.txt", chunkStart: 0, chunkEnd: 5, text: "world" };
  assert.equal(stableId(a), stableId(a));
  assert.notEqual(stableId(a), stableId(b));
});

test("chunkRecursive drops content below minChars", () => {
  assert.deepEqual(chunkRecursive("f.txt", "text", "tiny", cfg), []);
});
