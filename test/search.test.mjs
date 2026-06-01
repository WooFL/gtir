import { test } from "node:test";
import assert from "node:assert/strict";
import { fuseRRF } from "../src/search.mjs";

test("fuseRRF ranks a doc appearing in both branches above single-branch docs", () => {
  const vec = [{ id: "x", path: "x.py", line_start: 1, line_end: 2, language: "python", text: "x" },
               { id: "y", path: "y.py", line_start: 1, line_end: 2, language: "python", text: "y" }];
  const fts = [{ id: "x", path: "x.py", line_start: 1, line_end: 2, language: "python", text: "x" },
               { id: "z", path: "z.py", line_start: 1, line_end: 2, language: "python", text: "z" }];
  const ranked = fuseRRF(vec, fts, 5);
  assert.equal(ranked[0].path, "x.py");          // in both branches → top
  assert.equal(typeof ranked[0].score, "number");
  assert.ok(ranked[0].vec_rank === 1 && ranked[0].fts_rank === 1);
});

test("fuseRRF ftsWeight scales the BM25 branch (1 = classic RRF, 0 = vector-only order)", () => {
  const vec = [{ id: "a", path: "a.ts", line_start: 1, line_end: 2, language: "ts", text: "a" },
               { id: "b", path: "b.ts", line_start: 1, line_end: 2, language: "ts", text: "b" }];
  const fts = [{ id: "b", path: "b.ts", line_start: 1, line_end: 2, language: "ts", text: "b" }]; // b also ranks #1 in BM25
  assert.equal(fuseRRF(vec, fts, 5, 1)[0].path, "b.ts");   // BM25 lifts b above the vector-#1 a
  assert.equal(fuseRRF(vec, fts, 5, 0)[0].path, "a.ts");   // BM25 ignored → vector order (a first)
});

import { applyRerank } from "../src/search.mjs";

const F = (p) => ({ path: p, snippet: p, score: 0 });

test("applyRerank reorders fused by reranker indices and slices to k", () => {
  const fused = [F("a"), F("b"), F("c")];
  const ranked = [{ index: 2, score: 0.9 }, { index: 0, score: 0.5 }, { index: 1, score: 0.1 }];
  const out = applyRerank(fused, ranked, 2);
  assert.deepEqual(out.map((r) => r.path), ["c", "a"]);
  assert.equal(out[0].rerank_score, 0.9);
});

test("applyRerank falls back to RRF order when ranked is null or empty", () => {
  const fused = [F("a"), F("b")];
  assert.deepEqual(applyRerank(fused, null, 5).map((r) => r.path), ["a", "b"]);
  assert.deepEqual(applyRerank(fused, [], 5).map((r) => r.path), ["a", "b"]);
});

test("applyRerank appends fused rows the reranker omitted, preserving RRF order", () => {
  const fused = [F("a"), F("b"), F("c")];
  const ranked = [{ index: 1, score: 0.9 }];          // only b came back
  const out = applyRerank(fused, ranked, 5);
  assert.deepEqual(out.map((r) => r.path), ["b", "a", "c"]);
});

test("applyRerank ignores out-of-range indices from the server", () => {
  const fused = [F("a"), F("b")];
  const ranked = [{ index: 9, score: 0.9 }, { index: 0, score: 0.5 }];
  const out = applyRerank(fused, ranked, 5);
  assert.deepEqual(out.map((r) => r.path), ["a", "b"]);  // index 9 dropped; b appended
});
