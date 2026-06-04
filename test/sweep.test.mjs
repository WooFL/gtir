import { test } from "node:test";
import assert from "node:assert/strict";
import { gridCombos, parseGridSpec, sweepWeights, defaultObjective, rankSweep, weightsKey } from "../src/sweep.mjs";

test("gridCombos: cartesian product, axis order preserved", () => {
  assert.deepEqual(gridCombos({ ftsWeight: [0, 0.1], ftsWeightMixed: [0.3] }), [
    { ftsWeight: 0, ftsWeightMixed: 0.3 },
    { ftsWeight: 0.1, ftsWeightMixed: 0.3 },
  ]);
  assert.deepEqual(gridCombos({ a: [1, 2], b: [3, 4] }), [
    { a: 1, b: 3 }, { a: 1, b: 4 }, { a: 2, b: 3 }, { a: 2, b: 4 },
  ]);
});

test("gridCombos: empty/degenerate axes -> single empty combo", () => {
  assert.deepEqual(gridCombos({}), [{}]);
  assert.deepEqual(gridCombos(null), [{}]);
  assert.deepEqual(gridCombos({ a: [] }), [{}]);          // empty axis skipped
  assert.deepEqual(gridCombos({ a: [], b: [5] }), [{ b: 5 }]);
});

test("parseGridSpec: parses axes and values", () => {
  assert.deepEqual(parseGridSpec("ftsWeight=0,0.1,0.2;ftsWeightMixed=0.3"), {
    ftsWeight: [0, 0.1, 0.2], ftsWeightMixed: [0.3],
  });
  assert.deepEqual(parseGridSpec(" ftsWeight = 0 , 0.5 "), { ftsWeight: [0, 0.5] }); // tolerant of spaces
});

test("parseGridSpec: empty input -> {}; malformed -> throws", () => {
  assert.deepEqual(parseGridSpec(""), {});
  assert.deepEqual(parseGridSpec(null), {});
  assert.throws(() => parseGridSpec("ftsWeight"), /bad sweep axis/);        // no '='
  assert.throws(() => parseGridSpec("=0,1"), /bad sweep axis/);             // no key
  assert.throws(() => parseGridSpec("ftsWeight=a,b"), /bad sweep axis values/); // non-numeric
});

test("sweepWeights: runs evalFn per combo, threads weights into searchFnFor, preserves order", async () => {
  const combos = [{ ftsWeight: 0 }, { ftsWeight: 0.3 }];
  const seen = [];
  // searchFnFor records which weight it was built with; evalFn returns a metric derived from it
  // so we can assert each combo's weights reached the search it ran.
  const searchFnFor = (w) => { const tag = w.ftsWeight; return async () => tag; };
  const evalFn = async (_golden, searchFn) => { const tag = await searchFn(); seen.push(tag); return { mrr: tag }; };
  const rows = await sweepWeights(["q"], combos, searchFnFor, evalFn, { maxK: 5 });
  assert.deepEqual(seen, [0, 0.3]);
  assert.deepEqual(rows, [
    { weights: { ftsWeight: 0 }, metrics: { mrr: 0 } },
    { weights: { ftsWeight: 0.3 }, metrics: { mrr: 0.3 } },
  ]);
});

test("sweepWeights: onProgress fires once per combo with (i, n, weights)", async () => {
  const combos = [{ a: 1 }, { a: 2 }, { a: 3 }];
  const calls = [];
  await sweepWeights([], combos, () => async () => null, async () => ({ mrr: 0 }),
    { onProgress: (i, n, w) => calls.push([i, n, w]) });
  assert.deepEqual(calls, [[0, 3, { a: 1 }], [1, 3, { a: 2 }], [2, 3, { a: 3 }]]);
});

test("defaultObjective: mrr leads, recall@1 then recall@5 break ties", () => {
  assert.deepEqual(defaultObjective({ mrr: 0.9, recall: { 1: 0.8, 5: 1 } }), [0.9, 0.8, 1]);
  assert.deepEqual(defaultObjective({}), [0, 0, 0]);
});

test("rankSweep: orders best-first by objective; equal combos keep input order", () => {
  const rows = [
    { weights: { ftsWeight: 0 }, metrics: { mrr: 0.90, recall: { 1: 0.8 } } },
    { weights: { ftsWeight: 0.3 }, metrics: { mrr: 0.95, recall: { 1: 0.9 } } },
    { weights: { ftsWeight: 0.1 }, metrics: { mrr: 0.90, recall: { 1: 0.85 } } },
  ];
  const ranked = rankSweep(rows);
  assert.deepEqual(ranked.map((r) => r.weights.ftsWeight), [0.3, 0.1, 0]); // .95 > (.90,.85) > (.90,.80)
});

test("rankSweep: full tie preserves input order (prefer first-listed / simpler combo)", () => {
  const rows = [
    { weights: { ftsWeight: 0 }, metrics: { mrr: 0.9, recall: { 1: 0.8, 5: 1 } } },
    { weights: { ftsWeight: 0.5 }, metrics: { mrr: 0.9, recall: { 1: 0.8, 5: 1 } } },
  ];
  assert.deepEqual(rankSweep(rows).map((r) => r.weights.ftsWeight), [0, 0.5]);
});

test("weightsKey: compact stable key; empty -> (defaults)", () => {
  assert.equal(weightsKey({ ftsWeight: 0, ftsWeightMixed: 0.3 }), "ftsWeight=0,ftsWeightMixed=0.3");
  assert.equal(weightsKey({}), "(defaults)");
});
