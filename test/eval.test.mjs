import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLines, overlaps } from "../src/eval.mjs";
import { scoreGolden } from "../src/eval.mjs";
import { aggregate } from "../src/eval.mjs";
import { flattenMetrics, compareBaseline } from "../src/eval.mjs";
import { evalGolden } from "../src/eval.mjs";

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

test("aggregate: recall, mrr, sec_hit", () => {
  const records = [
    { pageRank: 1, secRank: 1, hasLines: true },
    { pageRank: 3, secRank: null, hasLines: true },
    { pageRank: null, secRank: null, hasLines: false },
    { pageRank: 2, secRank: 4, hasLines: true },
  ];
  const m = aggregate(records);
  assert.equal(m.n, 4);
  assert.equal(m.n_sec, 3);
  assert.equal(m.recall[1], 0.25);
  assert.equal(m.recall[5], 0.75);
  assert.equal(m.recall[10], 0.75);
  assert.equal(m.mrr, 0.4583);
  assert.equal(m.sec_hit[1], 0.3333);
  assert.equal(m.sec_hit[5], 0.6667);
});

test("aggregate: no sec entries → sec_hit null (n/a)", () => {
  const records = [{ pageRank: 1, secRank: null, hasLines: false }];
  const m = aggregate(records);
  assert.equal(m.n_sec, 0);
  assert.equal(m.sec_hit[1], null);
  assert.equal(m.sec_hit[5], null);
});

test("aggregate: empty records", () => {
  const m = aggregate([]);
  assert.equal(m.n, 0);
  assert.equal(m.recall[1], 0);
  assert.equal(m.mrr, 0);
});

const M = (recall, mrr, sec_hit) => ({ recall, mrr, sec_hit, n: 10, n_sec: 8 });

test("flattenMetrics: scalar keys; null sec_hit dropped", () => {
  const f = flattenMetrics(M({ 1: 0.5, 5: 0.8, 10: 0.9 }, 0.6, { 1: 0.4, 5: null }));
  assert.deepEqual(f, { "recall@1": 0.5, "recall@5": 0.8, "recall@10": 0.9, mrr: 0.6, "sec_hit@1": 0.4 });
});

test("compareBaseline: flags drops beyond tol, not within, not improvements", () => {
  const cur =  M({ 1: 0.50, 5: 0.80, 10: 0.90 }, 0.60, { 1: 0.40, 5: 0.60 });
  const base = M({ 1: 0.55, 5: 0.80, 10: 0.85 }, 0.60, { 1: 0.50, 5: 0.60 });
  const regs = compareBaseline(cur, base, 0.005);
  const keys = regs.map((r) => r.metric).sort();
  assert.deepEqual(keys, ["recall@1", "sec_hit@1"]);
});

test("compareBaseline: missing baseline metric is skipped (no false regression)", () => {
  const cur =  M({ 1: 0.50, 5: 0.80, 10: 0.90 }, 0.60, { 1: 0.40, 5: 0.60 });
  const base = { recall: { 1: 0.50 }, mrr: 0.60, sec_hit: {} };
  const regs = compareBaseline(cur, base, 0.005);
  assert.equal(regs.length, 0);
});

test("evalGolden: runs each query through searchFn and aggregates", async () => {
  const golden = [
    { query: "alpha", path: "a.ts", lines: [1, 9] },
    { query: "bravo", path: "b.ts" },
  ];
  const fake = async (q, k) => {
    assert.equal(k, 10);
    if (q === "alpha") return [R("a.ts", "1-9"), R("z.ts", "1-9")];
    return [R("x.ts", "1-9"), R("y.ts", "1-9"), R("b.ts", "1-9")];
  };
  const m = await evalGolden(golden, fake, { maxK: 10 });
  assert.equal(m.n, 2);
  assert.equal(m.recall[1], 0.5);
  assert.equal(m.recall[5], 1.0);
  assert.equal(m.n_sec, 1);
  assert.equal(m.sec_hit[1], 1.0);
});

test("evalGolden: empty golden throws", async () => {
  await assert.rejects(() => evalGolden([], async () => []), /golden set is empty/);
});
