import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkCentrality, centralityMultiplier } from "../src/graph-retrieval.mjs";

const degree = {
  call: new Map([["a.mjs#hub", 20], ["a.mjs#small", 1]]),
  importIn: new Map([["mod.mjs", 6]]),
};

test("chunkCentrality: max of declared-symbol call-degree", () => {
  assert.equal(chunkCentrality("function hub(){} function small(){}", "a.mjs", degree), 20);
});

test("chunkCentrality: file import in-degree counts when no high-degree symbol", () => {
  assert.equal(chunkCentrality("export const x = 1", "mod.mjs", degree), 6);
});

test("chunkCentrality: 0 when chunk declares nothing edged and file not imported", () => {
  assert.equal(chunkCentrality("// just a comment", "lonely.mjs", degree), 0);
});

test("centralityMultiplier: 1 at centrality 0; bounded by 1+weight; monotonic", () => {
  assert.equal(centralityMultiplier("// nothing", "lonely.mjs", degree), 1);
  const hub = centralityMultiplier("function hub(){}", "a.mjs", degree, { weight: 0.15, K: 8 });
  assert.ok(hub > 1 && hub <= 1.15);
  const small = centralityMultiplier("function small(){}", "a.mjs", degree, { weight: 0.15, K: 8 });
  assert.ok(hub > small);          // degree 20 boosts more than degree 1
});

import { applyCentrality, contextFor } from "../src/graph-retrieval.mjs";
import { buildGraph } from "../src/edge-graph.mjs";

test("applyCentrality (tiebreak): reorders within a near-equal score band, higher centrality first", () => {
  const deg = { call: new Map([["a.mjs#hub", 50]]), importIn: new Map() };
  const hits = [
    { path: "z.mjs", score: 0.3000, snippet: "function lonely(){}" },  // tied with a, no degree
    { path: "a.mjs", score: 0.3000, snippet: "function hub(){}" },     // tied, high degree
    { path: "low.mjs", score: 0.1000, snippet: "function lonely(){}" }, // far below the band
  ];
  const out = applyCentrality(hits, deg, { weight: 0.15, K: 8, eps: 0.001 });
  assert.equal(out[0].path, "a.mjs");        // within the tie band, higher centrality leads
  assert.ok(out[0].centrality > 1);
  assert.equal(out[2].path, "low.mjs");      // outside the band — rank preserved
  assert.equal(out.find((h) => h.path === "z.mjs").centrality, undefined); // ×1 → no annotation
});

test("applyCentrality (tiebreak): a clear score gap is NOT reordered (precision preserved)", () => {
  const deg = { call: new Map([["a.mjs#hub", 50]]), importIn: new Map() };
  const hits = [
    { path: "z.mjs", score: 0.30, snippet: "function lonely(){}" }, // clearly #1
    { path: "a.mjs", score: 0.25, snippet: "function hub(){}" },    // high degree but 0.05 below
  ];
  const out = applyCentrality(hits, deg, { weight: 0.15, K: 8, eps: 0.001 });
  assert.equal(out[0].path, "z.mjs"); // gap > eps → exact match keeps #1, centrality cannot override
});

test("contextFor: callers from rev, callees from fwd, precise keys, capped", () => {
  const g = buildGraph([
    { kind: "calls", conf: "resolved", from_path: "x.mjs", from_symbol: "caller", to_path: "a.mjs", to_symbol: "mid", candidates: [] },
    { kind: "calls", conf: "resolved", from_path: "a.mjs", from_symbol: "mid", to_path: "y.mjs", to_symbol: "callee", candidates: [] },
  ]);
  const ctx = contextFor("function mid(){}", "a.mjs", g, { cap: 5 });
  assert.deepEqual(ctx.callers, [{ path: "x.mjs", symbol: "caller" }]);
  assert.deepEqual(ctx.callees, [{ path: "y.mjs", symbol: "callee" }]);
  const empty = contextFor("// no symbols", "a.mjs", g);
  assert.deepEqual(empty, { callers: [], callees: [] });
});
