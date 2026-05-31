import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLines, overlaps } from "../src/eval.mjs";
import { scoreGolden } from "../src/eval.mjs";

test("parseLines: 'start-end' string", () => {
  assert.deepEqual(parseLines("12-40"), [12, 40]);
});
test("parseLines: single number", () => {
  assert.deepEqual(parseLines("7"), [7, 7]);
});
test("parseLines: whitespace and array forms", () => {
  assert.deepEqual(parseLines(" 3 - 9 "), [3, 9]);
  assert.deepEqual(parseLines([5, 8]), [5, 8]);
});

test("overlaps: touching, nested, disjoint, identical", () => {
  assert.equal(overlaps([1, 5], [5, 9]), true);
  assert.equal(overlaps([2, 8], [4, 6]), true);
  assert.equal(overlaps([1, 3], [4, 9]), false);
  assert.equal(overlaps([10, 20], [10, 20]), true);
});

const R = (path, lines) => ({ path, lines }); // fake search row

test("scoreGolden: page hit rank, no lines on entry", () => {
  const results = [R("a.ts", "1-9"), R("b.ts", "1-9"), R("c.ts", "1-9")];
  const s = scoreGolden(results, { query: "q", path: "b.ts" });
  assert.equal(s.pageRank, 2);
  assert.equal(s.secRank, null);
  assert.equal(s.hasLines, false);
});

test("scoreGolden: no page hit", () => {
  const results = [R("a.ts", "1-9"), R("b.ts", "1-9")];
  const s = scoreGolden(results, { query: "q", path: "z.ts" });
  assert.equal(s.pageRank, null);
});

test("scoreGolden: section hit needs path AND line overlap", () => {
  const results = [R("a.ts", "1-5"), R("a.ts", "30-40"), R("a.ts", "60-70")];
  const s = scoreGolden(results, { query: "q", path: "a.ts", lines: [32, 38] });
  assert.equal(s.pageRank, 1);
  assert.equal(s.secRank, 2);
  assert.equal(s.hasLines, true);
});

test("scoreGolden: page matches but no line overlap → secRank null", () => {
  const results = [R("a.ts", "1-5")];
  const s = scoreGolden(results, { query: "q", path: "a.ts", lines: [50, 60] });
  assert.equal(s.pageRank, 1);
  assert.equal(s.secRank, null);
});

test("scoreGolden: path as array (any-match)", () => {
  const results = [R("x.ts", "1-9"), R("b.ts", "1-9")];
  const s = scoreGolden(results, { query: "q", path: ["a.ts", "b.ts"] });
  assert.equal(s.pageRank, 2);
});
