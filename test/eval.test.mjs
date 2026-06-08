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

test("scoreGolden: missing path throws (malformed golden entry)", () => {
  assert.throws(() => scoreGolden([R("a.ts", "1-9")], { query: "q" }), /missing.*path/i);
});
test("scoreGolden: a valid path simply not in results is a normal miss, not an error", () => {
  const s = scoreGolden([R("a.ts", "1-9")], { query: "q", path: "not-in-corpus.ts" });
  assert.equal(s.pageRank, null);
});

test("compareBaseline: a sec_hit metric that became n/a (golden lost its lines) is NOT a phantom regression", () => {
  const cur =  { recall: { 1: 0.5, 5: 0.8, 10: 0.9 }, mrr: 0.6, sec_hit: { 1: null, 5: null } }; // n_sec went to 0
  const base = { recall: { 1: 0.5, 5: 0.8, 10: 0.9 }, mrr: 0.6, sec_hit: { 1: 0.4, 5: 0.6 } };
  const regs = compareBaseline(cur, base, 0.005);
  assert.equal(regs.length, 0, "a vanished sec_hit is a benchmark change, not a retrieval regression");
});

test("compareBaseline: a real drop in a shared metric is still flagged", () => {
  const cur =  { recall: { 1: 0.40, 5: 0.80, 10: 0.90 }, mrr: 0.60, sec_hit: { 1: 0.40, 5: 0.60 } };
  const base = { recall: { 1: 0.55, 5: 0.80, 10: 0.90 }, mrr: 0.60, sec_hit: { 1: 0.40, 5: 0.60 } };
  const regs = compareBaseline(cur, base, 0.005);
  assert.deepEqual(regs.map((r) => r.metric), ["recall@1"]);
});

import { compareTiers } from "../src/eval.mjs";

test("evalGolden: splits records into byTier (gate/hard), overall unchanged", async () => {
  const golden = [
    { query: "g1", path: "a.ts", lines: [1, 9], tier: "gate" },
    { query: "g2", path: "b.ts", tier: "gate" },
    { query: "h1", path: "c.ts", tier: "hard" },
  ];
  const fake = async (q) => {
    if (q === "g1") return [R("a.ts", "1-9")];                 // gate hit @1
    if (q === "g2") return [R("b.ts", "1-9")];                 // gate hit @1
    return [R("x.ts", "1-9"), R("y.ts", "1-9"), R("c.ts", "1-9")]; // hard hit @3
  };
  const m = await evalGolden(golden, fake, { maxK: 10 });
  assert.equal(m.n, 3);                       // overall still present
  assert.ok(m.byTier.gate && m.byTier.hard);
  assert.equal(m.byTier.gate.n, 2);
  assert.equal(m.byTier.gate.recall[1], 1.0);
  assert.equal(m.byTier.hard.n, 1);
  assert.equal(m.byTier.hard.recall[1], 0.0);
  assert.equal(m.byTier.hard.recall[5], 1.0);
});

test("evalGolden: entry with no tier defaults to gate", async () => {
  const golden = [{ query: "x", path: "a.ts" }];
  const m = await evalGolden(golden, async () => [R("a.ts", "1-9")], { maxK: 10 });
  assert.equal(m.byTier.gate.n, 1);
  assert.equal(m.byTier.hard, undefined);
});

test("compareTiers: flags a per-tier regression with a tier-prefixed metric", () => {
  const cur =  { byTier: { hard: M({ 1: 0.40, 5: 0.80, 10: 0.90 }, 0.5, { 1: 0.3, 5: 0.5 }) } };
  const base = { byTier: { hard: M({ 1: 0.55, 5: 0.80, 10: 0.90 }, 0.5, { 1: 0.3, 5: 0.5 }) } };
  const regs = compareTiers(cur, base, 0.005);
  assert.deepEqual(regs.map((r) => r.metric), ["hard:recall@1"]);
});

test("compareTiers: a tier missing from baseline is skipped (no false regression)", () => {
  const cur =  { byTier: { hard: M({ 1: 0.4, 5: 0.8, 10: 0.9 }, 0.5, { 1: 0.3, 5: 0.5 }) } };
  const base = { byTier: {} };
  assert.equal(compareTiers(cur, base, 0.005).length, 0);
});

import { scoreEdgeGolden, evalEdges } from "../src/eval.mjs";
import { readFileSync } from "node:fs";

const edges = [
  { kind: "calls", conf: "resolved", from_path: "mw.ts", to_path: "token.ts", to_symbol: "verifyToken" },
  { kind: "calls", conf: "ambiguous", from_path: "x.ts", to_path: null, to_symbol: null, candidates: ["a.ts", "b.ts"] },
  { kind: "calls", conf: "external", from_path: "y.ts", to_path: null, to_symbol: null },
];

test("scoreEdgeGolden flags a present resolved edge as a hit", () => {
  const hit = scoreEdgeGolden(edges, { from: "mw.ts", to: "token.ts", symbol: "verifyToken", kind: "calls" });
  assert.equal(hit.found, true);
  assert.equal(hit.resolved, true);
});
test("scoreEdgeGolden misses an absent edge", () => {
  const hit = scoreEdgeGolden(edges, { from: "nope.ts", to: "token.ts", symbol: "verifyToken", kind: "calls" });
  assert.equal(hit.found, false);
});
test("evalEdges reports recall and resolution split", () => {
  const golden = [
    { from: "mw.ts", to: "token.ts", symbol: "verifyToken", kind: "calls" },
    { from: "absent.ts", to: "z.ts", symbol: "q", kind: "calls" },
  ];
  const m = evalEdges(edges, golden);
  assert.equal(m.recall, 0.5);
  assert.equal(m.split.resolved, 1);
  assert.equal(m.split.ambiguous, 1);
  assert.equal(m.split.external, 1);
});

test("evalEdges split counts inferred edges", () => {
  const edges = [
    { kind: "calls", conf: "inferred", from_symbol: "f", to_symbol: "g", to_path: "b.mjs", ref_name: "g" },
    { kind: "calls", conf: "resolved", from_symbol: "x", to_symbol: "y", to_path: "c.mjs", ref_name: "y" },
  ];
  const r = evalEdges(edges, []);
  assert.equal(r.split.inferred, 1);
  assert.equal(r.split.resolved, 1);
});

test("edges-golden.json is a non-empty array of well-formed entries", () => {
  const golden = JSON.parse(readFileSync(new URL("../eval/edges-golden.json", import.meta.url)));
  assert.ok(Array.isArray(golden) && golden.length >= 8);
  for (const g of golden) {
    assert.ok(g.from && g.kind, `entry missing from/kind: ${JSON.stringify(g)}`);
    assert.ok(["calls", "links", "imports", "embeds"].includes(g.kind));
  }
});

import { scoreEdge } from "../src/eval.mjs";

// Edges carrying ref_name (what scoreEdge keys on), unlike the to_symbol-keyed set above.
const callEdges = [
  { kind: "calls", conf: "resolved", from_path: "a.ts", to_path: "b.ts", ref_name: "g" },
  { kind: "calls", conf: "resolved", from_path: "c.ts", to_path: "wrong.ts", ref_name: "h" },
  { kind: "calls", conf: "external", from_path: "x.ts", to_path: null, ref_name: "ext" },
];

test("scoreEdge: produced edge hits the expected target → correct", () => {
  assert.equal(scoreEdge(callEdges, { from: "a.ts", to: "b.ts", symbol: "g", kind: "calls" }), "correct");
});
test("scoreEdge: produced edge resolves to a different file → wrong", () => {
  assert.equal(scoreEdge(callEdges, { from: "c.ts", to: "right.ts", symbol: "h", kind: "calls" }), "wrong");
});
test("scoreEdge: no produced edge for the call → missing", () => {
  assert.equal(scoreEdge(callEdges, { from: "a.ts", to: "b.ts", symbol: "absent", kind: "calls" }), "missing");
});
test("scoreEdge: expected-external (to=null) matched by an external edge → correct", () => {
  assert.equal(scoreEdge(callEdges, { from: "x.ts", to: null, symbol: "ext", kind: "calls" }), "correct");
});
test("scoreEdge: expected-external but edge resolved to a file → wrong", () => {
  assert.equal(scoreEdge(callEdges, { from: "a.ts", to: null, symbol: "g", kind: "calls" }), "wrong");
});
test("scoreEdge: any produced edge hitting the target counts (multi-call site)", () => {
  const multi = [
    { kind: "calls", conf: "ambiguous", from_path: "m.ts", to_path: null, ref_name: "f" },
    { kind: "calls", conf: "resolved", from_path: "m.ts", to_path: "t.ts", ref_name: "f" },
  ];
  assert.equal(scoreEdge(multi, { from: "m.ts", to: "t.ts", symbol: "f", kind: "calls" }), "correct");
});

import { evalEdgeExtraction } from "../src/eval.mjs";

test("evalEdgeExtraction: recall/wrong/missing sum to 1, byLang groups by `from` extension, split counts conf", () => {
  const edges = [
    { kind: "calls", conf: "resolved", from_path: "a.ts", to_path: "b.ts", ref_name: "g" },     // correct (ts)
    { kind: "calls", conf: "resolved", from_path: "c.py", to_path: "wrong.py", ref_name: "h" },  // wrong   (py)
    { kind: "calls", conf: "inferred", from_path: "d.py", to_path: "e.py", ref_name: "k" },       // correct (py)
    { kind: "calls", conf: "ambiguous", from_path: "z.ts", to_path: null, ref_name: "noise" },    // not in golden
  ];
  const golden = [
    { from: "a.ts", to: "b.ts", symbol: "g", kind: "calls" },
    { from: "c.py", to: "right.py", symbol: "h", kind: "calls" },
    { from: "d.py", to: "e.py", symbol: "k", kind: "calls" },
    { from: "x.ts", to: "y.ts", symbol: "absent", kind: "calls" }, // missing (ts)
  ];
  const m = evalEdgeExtraction(edges, golden);
  assert.equal(m.n, 4);
  assert.deepEqual(m.tally, { correct: 2, wrong: 1, missing: 1 });
  assert.equal(m.recall, 0.5);
  assert.equal(m.wrong_rate, 0.25);
  assert.equal(m.missing_rate, 0.25);
  // rates sum to 1 (inline tolerance — `round` is module-private, not importable here)
  assert.ok(Math.abs(m.recall + m.wrong_rate + m.missing_rate - 1) < 1e-9);
  assert.deepEqual(m.byLang.ts, { correct: 1, wrong: 0, missing: 1, n: 2 });
  assert.deepEqual(m.byLang.py, { correct: 1, wrong: 1, missing: 0, n: 2 });
  assert.deepEqual(m.split, { resolved: 2, inferred: 1, ambiguous: 1, external: 0 });
});

test("evalEdgeExtraction: empty golden → zeros, no divide-by-zero", () => {
  const m = evalEdgeExtraction([], []);
  assert.equal(m.n, 0);
  assert.equal(m.recall, 0);
  assert.deepEqual(m.tally, { correct: 0, wrong: 0, missing: 0 });
});
