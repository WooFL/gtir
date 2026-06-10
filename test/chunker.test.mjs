import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkRecursive, stableId } from "../src/chunker.mjs";
import { chunkFile } from "../src/chunker.mjs";
import { contextualizeChunk } from "../src/contextualize.mjs";

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

test("chunkFile (cpp) AST-chunks methods with a class/namespace scope breadcrumb", async () => {
  // The class exceeds maxChars (container → dropped), so its methods surface as their own chunks.
  // `scope` is only ever set on the AST path, so finding it proves the cpp grammar actually loaded
  // (a silent recursive fallback would label language "cpp" too, but never produce a scope).
  const cpp = [
    "namespace geo {",
    "class Widget {",
    "public:",
    "  void build() { configure(); warmUp(); /* a long-ish body so this method comfortably clears minChars */ }",
    "  int render() const { drawFrame(); /* another padded body so this method also clears the minimum size */ return 0; }",
    "};",
    "}",
  ].join("\n");
  const chunks = await chunkFile("w.cpp", ".cpp", cpp, { maxChars: 150, minChars: 20, overlapChars: 20 });
  assert.equal(chunks[0].language, "cpp");
  const scoped = chunks.filter((c) => c.scope && c.scope.includes("Widget"));
  assert.ok(scoped.length >= 1, `expected a chunk scoped to Widget, got: ${JSON.stringify(chunks.map((c) => c.scope))}`);
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

// --- Oversize-leaf re-split (recall hole fix) ---

const OVERSIZE_LEAF_PY = [
  "# header comment line one",
  "# header comment line two",
  "def process_records(records):",
  "    total = 0",
  "    # accumulate every record value into a running total for the summary report",
  "    for r in records:",
  "        total += r.value  # add this record's value to the running accumulator",
  "    # distinctive deep marker sits far inside this oversize leaf function body",
  "    average = total / max(len(records), 1)",
  "    return {\"total\": total, \"average\": average, \"count\": len(records)}",
].join("\n");

test("oversize leaf function is re-split, not dropped, with file-relative lines", async () => {
  const cfg = { maxChars: 150, minChars: 20, overlapChars: 0 };
  const chunks = await chunkFile("data/report.py", ".py", OVERSIZE_LEAF_PY, cfg);
  assert.ok(chunks.length >= 2, `expected re-split into >=2 windows, got ${chunks.length}`);
  assert.ok(chunks.some((c) => c.text.includes("distinctive deep marker")), "deep passage missing");
  assert.equal(chunks[0].lineStart, 3, "lineStart must be file-relative");
  for (const c of chunks) assert.ok(c.text.length >= cfg.minChars);
});

const OVERSIZE_CONTAINER_PY = [
  "class Repository:",
  "    def find(self, identifier):",
  "        # look up a stored item by its identifier and return it to the caller",
  "        return self.store.get(identifier)",
  "",
  "    def save(self, item):",
  "        # persist the given item into the backing store keyed by its identifier",
  "        self.store[item.identifier] = item",
].join("\n");

test("oversize container class is NOT re-split (members surface, no duplication)", async () => {
  const cfg = { maxChars: 150, minChars: 20, overlapChars: 0 };
  const chunks = await chunkFile("data/repo.py", ".py", OVERSIZE_CONTAINER_PY, cfg);
  assert.ok(!chunks.some((c) => c.text.includes("class Repository")), "container was wrongly re-split");
  assert.ok(chunks.some((c) => c.text.includes("def find")), "find method missing");
  assert.ok(chunks.some((c) => c.text.includes("def save")), "save method missing");
  const spans = chunks.map((c) => `${c.chunkStart}:${c.chunkEnd}`);
  assert.equal(new Set(spans).size, spans.length, "duplicate spans emitted");
});

test("oversize leaf coordinate offset: text is found at chunkStart in the source", async () => {
  const cfg = { maxChars: 150, minChars: 20, overlapChars: 0 };
  const chunks = await chunkFile("data/report.py", ".py", OVERSIZE_LEAF_PY, cfg);
  for (const c of chunks) {
    const at = OVERSIZE_LEAF_PY.slice(c.chunkStart, c.chunkStart + c.text.length);
    assert.equal(at, c.text, `chunk text not located at chunkStart=${c.chunkStart}`);
  }
});

test("normal (under-maxChars) function still yields exactly one chunk (no regression)", async () => {
  const cfg = { maxChars: 2000, minChars: 20, overlapChars: 0 };
  const py = [
    "def small(n):",
    "    # a short helper well under the maxChars threshold so it stays one chunk",
    "    return n * 2 + 1",
  ].join("\n");
  const chunks = await chunkFile("data/small.py", ".py", py, cfg);
  assert.equal(chunks.length, 1);
});

// --- Structural code prefixes (AST scope breadcrumb, additive to the first line) ---

test("a method's chunk carries its enclosing class in `scope`", async () => {
  const cfg = { maxChars: 2000, minChars: 20, overlapChars: 0 };
  const py = [
    "class Repository:",
    "    def find(self, identifier):",
    "        # look up a stored item by its identifier and return it to the caller",
    "        return self.store.get(identifier)",
  ].join("\n");
  const chunks = await chunkFile("data/repo.py", ".py", py, cfg);
  const c = chunks.find((c) => c.text.includes("def find"));
  assert.ok(c, "find method chunk missing");
  assert.deepEqual(c.scope, ["Repository"]);
  const cx = await contextualizeChunk(c, cfg);
  assert.ok(cx.embedText.startsWith("data/repo.py › Repository — "), `embedText: ${cx.embedText.slice(0, 80)}`);
});

test("nested scope yields scope [Outer, Inner] in order", async () => {
  const cfg = { maxChars: 2000, minChars: 20, overlapChars: 0 };
  const py = [
    "class Outer:",
    "    class Inner:",
    "        def deep_method(self, value):",
    "            # a method nested two scopes deep to verify the full breadcrumb chain",
    "            return value * 2",
  ].join("\n");
  const chunks = await chunkFile("m/nested.py", ".py", py, cfg);
  const c = chunks.find((c) => c.text.includes("deep_method"));
  assert.ok(c, "nested method chunk missing");
  assert.deepEqual(c.scope, ["Outer", "Inner"]);
});

test("top-level function has no scope; synthetic prefix keeps the first line", async () => {
  const cfg = { maxChars: 2000, minChars: 20, overlapChars: 0 };
  const py = [
    "def standalone(x):",
    "    # a module-level function with no enclosing class or module wrapper at all",
    "    return x + 1",
  ].join("\n");
  const chunks = await chunkFile("m/top.py", ".py", py, cfg);
  const c = chunks.find((c) => c.text.includes("standalone"));
  assert.ok(c, "top-level chunk missing");
  assert.equal(c.scope, undefined, "no enclosing container → no scope");
  const cx = await contextualizeChunk(c, cfg);
  assert.ok(cx.embedText.startsWith("m/top.py — "), `embedText: ${cx.embedText.slice(0, 60)}`);
  assert.ok(cx.embedText.includes("standalone"), "first line (signature) is retained");
});

test("oversize-leaf sub-chunks carry the function name in scope", async () => {
  const cfg = { maxChars: 150, minChars: 20, overlapChars: 0 };
  const py = [
    "def process_records(records):",
    "    total = 0",
    "    # accumulate every record value into a running total for the summary report",
    "    for r in records:",
    "        total += r.value  # add this record's value to the running accumulator",
    "    # distinctive deep marker sits far inside this oversize leaf function body",
    "    average = total / max(len(records), 1)",
    "    return {\"total\": total, \"average\": average, \"count\": len(records)}",
  ].join("\n");
  const chunks = await chunkFile("data/report.py", ".py", py, cfg);
  assert.ok(chunks.length >= 2, "expected oversize re-split");
  for (const c of chunks) {
    assert.ok(c.scope && c.scope.includes("process_records"), `sub-chunk scope missing func name: ${JSON.stringify(c.scope)}`);
  }
});

test("grammarless chunk has no scope; synthetic embedText still produced", async () => {
  const cfg = { maxChars: 2000, minChars: 20, overlapChars: 0 };
  const body = "fn main() { let x = 1; }\n".repeat(6);
  const chunks = await chunkFile("s.wgsl", ".wgsl", body, cfg);
  assert.ok(chunks.length >= 1);
  assert.equal(chunks[0].scope, undefined, "grammarless chunk should not get a scope");
  const cx = await contextualizeChunk(chunks[0], cfg);
  assert.ok(cx.embedText.includes(chunks[0].text), "synthetic fallback embedText must include the body");
  assert.ok(cx.embedText.startsWith("s.wgsl"), "synthetic prefix should lead with the path");
});

test("contextualizeChunk builds 'path › scope — firstline' then the body", async () => {
  const cfg = { maxChars: 2000, minChars: 20, overlapChars: 0 };
  const py = [
    "class Service:",
    "    def run(self, job):",
    "        # execute the given job and return its computed result to the caller now",
    "        return job.execute()",
  ].join("\n");
  const chunks = await chunkFile("svc.py", ".py", py, cfg);
  const c = chunks.find((c) => c.text.includes("def run"));
  const cx = await contextualizeChunk(c, cfg);
  assert.ok(cx.embedText.startsWith("svc.py › Service — "), `embedText: ${cx.embedText.slice(0, 60)}`);
  assert.ok(cx.embedText.endsWith(c.text), "body follows the prefix");
});

test("contextScope: false suppresses the code scope breadcrumb (plain synthetic)", async () => {
  const py = [
    "class Service:",
    "    def run(self, job):",
    "        # execute the given job and return its computed result to the caller now",
    "        return job.execute()",
  ].join("\n");
  const chunks = await chunkFile("svc.py", ".py", py, { maxChars: 2000, minChars: 20, overlapChars: 0 });
  const c = chunks.find((c) => c.text.includes("def run"));
  assert.ok(c.scope && c.scope.includes("Service"), "chunker still attaches scope (cheap, always)");
  const cx = await contextualizeChunk(c, { contextScope: false });
  assert.ok(!cx.embedText.includes("› Service"), `scope must be suppressed: ${cx.embedText.slice(0, 60)}`);
  assert.ok(cx.embedText.startsWith("svc.py — "), `should be plain synthetic: ${cx.embedText.slice(0, 60)}`);
});

test("chunkFile (js): a merged AST chunk carries per-symbol spans in `symbols`", async () => {
  const js = [
    "function alpha(x) { return x + 1; }",   // line 1
    "function beta(y) { return y * 2; }",     // line 2
  ].join("\n");
  const chunks = await chunkFile("m.mjs", ".mjs", js, astCfg);
  const syms = chunks.flatMap((c) => c.symbols || []);
  assert.deepEqual(syms.map((s) => s.name).sort(), ["alpha", "beta"]);
  const alpha = syms.find((s) => s.name === "alpha");
  const beta = syms.find((s) => s.name === "beta");
  assert.equal(alpha.lineStart, 1); assert.equal(alpha.lineEnd, 1);
  assert.equal(beta.lineStart, 2); assert.equal(beta.lineEnd, 2);
});

test("chunkRecursive (non-AST) chunks have no `symbols`", () => {
  const chunks = chunkRecursive("f.txt", "text", Array.from({ length: 12 }, (_, i) => `line ${i} of some text here`).join("\n"), cfg);
  for (const c of chunks) assert.equal(c.symbols, undefined);
});

test("chunkFile: an oversize function split into windows tags each window with its symbol", async () => {
  const tinyCfg = { maxChars: 80, minChars: 20, overlapChars: 10 };
  const body = Array.from({ length: 8 }, (_, i) => `  const v${i} = ${i} + someValueThatPads;`).join("\n");
  const js = `function bigFn(a) {\n${body}\n  return a;\n}`;
  const chunks = await chunkFile("big.mjs", ".mjs", js, tinyCfg);
  // at least one chunk, and every chunk that has symbols names bigFn
  const withSyms = chunks.filter((c) => c.symbols && c.symbols.length);
  assert.ok(withSyms.length >= 1, "expected at least one window tagged with a symbol");
  for (const c of withSyms) {
    assert.ok(c.symbols.every((s) => s.name === "bigFn"), "oversize-leaf windows name the leaf symbol");
  }
});
