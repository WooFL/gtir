import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkRecursive, stableId } from "../src/chunker.mjs";
import { chunkFile } from "../src/chunker.mjs";

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

const astCfg = { maxChars: 2000, minChars: 20, overlapChars: 100 };

test("chunkFile (python) emits a chunk per function/class via AST", async () => {
  const py = [
    "def alpha():",
    "    return sum([1, 2, 3, 4, 5, 6, 7, 8])  # padding to clear minChars",
    "",
    "class Beta:",
    "    def gamma(self):",
    "        return 'a reasonably long string body to exceed the minimum'",
  ].join("\n");
  const chunks = await chunkFile("m.py", ".py", py, astCfg);
  const texts = chunks.map((c) => c.text).join("\n---\n");
  assert.match(texts, /def alpha/);
  assert.match(texts, /class Beta/);
});

test("chunkFile falls back to recursive for grammarless ext", async () => {
  const body = Array.from({ length: 40 }, (_, i) => `shader line ${i} value`).join("\n");
  const chunks = await chunkFile("s.wgsl", ".wgsl", body, astCfg);
  assert.ok(chunks.length >= 1);
  assert.equal(chunks[0].language, "wgsl");
});

test("cAST merge: many tiny adjacent functions coalesce into fewer chunks", async () => {
  // Six one-line functions, each individually below minChars=80.
  const tiny = Array.from({ length: 6 }, (_, i) => `def f${i}(): return ${i}`).join("\n\n");
  const merged = await chunkFile("tiny.py", ".py", tiny, { maxChars: 200, minChars: 80, overlapChars: 0 });
  assert.ok(merged.length >= 1, "small siblings should not all be dropped");
  // Each emitted chunk respects the size budget.
  for (const c of merged) assert.ok(c.text.length <= 200);
  // At least one chunk contains two merged functions.
  assert.ok(merged.some((c) => /f0/.test(c.text) && /f1/.test(c.text)));
});
