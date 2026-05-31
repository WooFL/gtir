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
  // Six one-line functions separated by blank lines.
  // Source layout (0-indexed rows):
  //   row 0:  "def f0(): return 0"  startIndex=0   endIndex=18
  //   row 2:  "def f1(): return 1"  startIndex=20  endIndex=38
  //   row 4:  "def f2(): return 2"  startIndex=40  endIndex=58
  //   row 6:  "def f3(): return 3"  startIndex=60  endIndex=78
  //   row 8:  "def f4(): return 4"  startIndex=80  endIndex=98
  //   row 10: "def f5(): return 5"  startIndex=100 endIndex=118
  //
  // With maxChars=60, minChars=20:
  //   - f0+f1+f2 combined span = 58 <= 60  -> group 1 (startIndex=0..58)
  //   - adding f3 would reach span 78 > 60  -> flush group 1, start group 2 at f3
  //   - f3+f4+f5 combined span = 58 <= 60  -> group 2 (startIndex=60..118)
  //   -> exactly 2 chunks from the MERGE path
  //
  // The recursive FALLBACK with these same settings flushes at the blank line after f2
  // (bucketChars hits 60 on line 6, a blank line), so fallback chunk1.lineEnd === 6.
  // The MERGE path anchors lineEnd to the AST node's endRow, giving chunk1.lineEnd === 5.
  // These assertions would FAIL on the fallback path, proving the merge path fired.
  const tiny = Array.from({ length: 6 }, (_, i) => `def f${i}(): return ${i}`).join("\n\n");
  const merged = await chunkFile("tiny.py", ".py", tiny, { maxChars: 60, minChars: 20, overlapChars: 0 });

  // 1. Exact chunk count predicted by greedy merge (would be 1 on maxChars=200 fallback-identical case).
  assert.equal(merged.length, 2, "greedy merge must produce exactly 2 chunks for maxChars=60");

  // 2. Each emitted chunk respects the size budget.
  for (const c of merged) assert.ok(c.text.length <= 60, `chunk text exceeds maxChars: ${c.text.length}`);

  // 3. Content grouping: first chunk covers f0-f2, second covers f3-f5.
  assert.match(merged[0].text, /f0/);
  assert.match(merged[0].text, /f2/);
  assert.match(merged[1].text, /f3/);
  assert.match(merged[1].text, /f5/);

  // 4. AST-anchored line numbers — the key distinguisher from the recursive fallback.
  //    Merge: chunk1.lineEnd = f2's endRow+1 = 5.  Fallback: lineEnd = 6 (blank-line flush).
  //    Merge: chunk2.lineStart = f3's startRow+1 = 7. Fallback: lineStart = 7 (coincidence, but
  //    chunk2.lineEnd = 11 for merge vs 11 for fallback — so lineEnd check on chunk1 is the real pin).
  assert.equal(merged[0].lineStart, 1,  "chunk1 lineStart must be 1 (f0 row 0)");
  assert.equal(merged[0].lineEnd,   5,  "chunk1 lineEnd must be 5 (f2 row 4) — fallback gives 6");
  assert.equal(merged[1].lineStart, 7,  "chunk2 lineStart must be 7 (f3 row 6)");
  assert.equal(merged[1].lineEnd,   11, "chunk2 lineEnd must be 11 (f5 row 10)");
});

test("chunkRecursive does not duplicate a single oversize line", () => {
  const longLine = "x".repeat(300); // one line, >> maxChars below
  const chunks = chunkRecursive("h.txt", "text", longLine, { maxChars: 120, minChars: 20, overlapChars: 30 });
  const ids = chunks.map(stableId);
  assert.equal(new Set(ids).size, ids.length, "no duplicate chunk ids");
  assert.equal(chunks.length, 1, "a single oversize line must yield exactly one chunk");
});

test("chunkRecursive does not emit an oversize overlap blob for adjacent long lines", () => {
  const a = "a".repeat(200), b = "b".repeat(200);
  const chunks = chunkRecursive("h.txt", "text", a + "\n" + b, { maxChars: 120, minChars: 20, overlapChars: 30 });
  for (const c of chunks) assert.equal(new Set(chunks.map(stableId)).size, chunks.length); // unique ids
  // No chunk should exceed maxChars by carrying a whole prior line forward.
  for (const c of chunks) assert.ok(c.text.length <= 200 + 1, "no merged oversize overlap blob");
});

test("chunkFile routes .md through chunkMarkdown (chunks carry a prefix)", async () => {
  const md = "# Title\n\nSome real markdown content under a heading, long enough to be a chunk here.";
  const chunks = await chunkFile("notes/p.md", ".md", md, { maxChars: 2000, minChars: 20, overlapChars: 100 });
  assert.ok(chunks.length >= 1);
  assert.equal(chunks[0].language, "markdown");
  assert.ok(chunks[0].prefix, "markdown chunk should carry a breadcrumb prefix");
  assert.match(chunks[0].prefix, /notes\/p\.md › p › Title/);
});
