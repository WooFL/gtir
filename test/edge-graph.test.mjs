import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeKey, buildGraph } from "../src/edge-graph.mjs";

const E = {
  call: (fp, fs, tp, ts) => ({ kind: "calls", conf: "resolved", from_path: fp, from_symbol: fs, to_path: tp, to_symbol: ts, candidates: [] }),
  ambCall: (fp, fs, name, cands) => ({ kind: "calls", conf: "ambiguous", from_path: fp, from_symbol: fs, to_path: null, to_symbol: null, ref_name: name, candidates: cands }),
  extCall: (fp, fs, name) => ({ kind: "calls", conf: "external", from_path: fp, from_symbol: fs, to_path: null, to_symbol: null, ref_name: name, candidates: [] }),
  imp: (fp, tp) => ({ kind: "imports", conf: "resolved", from_path: fp, from_symbol: "./x", to_path: tp, to_symbol: null, candidates: [] }),
};

test("nodeKey: symbol node vs file node", () => {
  assert.equal(nodeKey("a.mjs", "foo"), "a.mjs#foo");
  assert.equal(nodeKey("a.mjs", null), "a.mjs");
});

test("buildGraph: resolved call edge wires symbol nodes both directions", () => {
  const g = buildGraph([E.call("a.mjs", "f", "b.mjs", "g")]);
  assert.deepEqual([...g.fwd.get("a.mjs#f")], ["b.mjs#g"]);
  assert.deepEqual([...g.rev.get("b.mjs#g")], ["a.mjs#f"]);
  assert.equal(g.nodeMeta.get("b.mjs#g").path, "b.mjs");
  assert.equal(g.nodeMeta.get("b.mjs#g").symbol, "g");
});

test("buildGraph: top-level call (null from_symbol) uses file node as source", () => {
  const g = buildGraph([E.call("a.mjs", null, "b.mjs", "g")]);
  assert.ok(g.fwd.get("a.mjs").has("b.mjs#g"));
});

test("buildGraph: import edge is file->file", () => {
  const g = buildGraph([E.imp("a.mjs", "b.mjs")]);
  assert.ok(g.fwd.get("a.mjs").has("b.mjs"));
  assert.equal(g.edgeList[0].kind, "imports");
});

test("buildGraph: external edges skipped; ambiguous skipped unless includeAmbiguous", () => {
  const edges = [E.extCall("a.mjs", "f", "Error"), E.ambCall("a.mjs", "f", "parse", ["b.mjs", "c.mjs"])];
  assert.equal(buildGraph(edges).edgeList.length, 0);
  const g2 = buildGraph(edges, { includeAmbiguous: true });
  assert.deepEqual([...g2.fwd.get("a.mjs#f")].sort(), ["b.mjs#parse", "c.mjs#parse"]);
  assert.ok(g2.edgeList.every((e) => e.conf === "ambiguous"));
});

import { impact } from "../src/edge-graph.mjs";

// chain: a#f -> b#g -> c#h ; and d#x -> b#g (so b has two upstream paths)
const chain = buildGraph([
  E.call("a.mjs", "f", "b.mjs", "g"),
  E.call("b.mjs", "g", "c.mjs", "h"),
  E.call("d.mjs", "x", "b.mjs", "g"),
]);

test("impact upstream: transitive callers of c#h", () => {
  const r = impact(chain, ["c.mjs#h"]);
  const keys = r.nodes.map((n) => n.key).sort();
  assert.deepEqual(keys, ["a.mjs#f", "b.mjs#g", "d.mjs#x"]);
  assert.equal(r.nodes.find((n) => n.key === "b.mjs#g").depth, 1);
  assert.equal(r.nodes.find((n) => n.key === "a.mjs#f").depth, 2);
});

test("impact downstream: what a#f calls", () => {
  const r = impact(chain, ["a.mjs#f"], { direction: "downstream" });
  assert.deepEqual(r.nodes.map((n) => n.key).sort(), ["b.mjs#g", "c.mjs#h"]);
});

test("impact depth caps hops", () => {
  const r = impact(chain, ["c.mjs#h"], { depth: 1 });
  assert.deepEqual(r.nodes.map((n) => n.key).sort(), ["b.mjs#g"]);
});

test("impact dedups diamonds and excludes the start node", () => {
  const g = buildGraph([
    E.call("top.mjs", "t", "l.mjs", "a"),
    E.call("top.mjs", "t", "r.mjs", "b"),
    E.call("l.mjs", "a", "btm.mjs", "z"),
    E.call("r.mjs", "b", "btm.mjs", "z"),
  ]);
  const r = impact(g, ["btm.mjs#z"]);
  assert.equal(r.nodes.filter((n) => n.key === "top.mjs#t").length, 1);
  assert.ok(!r.nodes.some((n) => n.key === "btm.mjs#z"));
});

test("impact limit sets truncated", () => {
  const r = impact(chain, ["c.mjs#h"], { limit: 1 });
  assert.equal(r.truncated, true);
  assert.equal(r.nodes.length, 1);
});

test("impact empty when start has no callers", () => {
  const r = impact(chain, ["a.mjs#f"]);
  assert.deepEqual(r.nodes, []);
  assert.equal(r.truncated, false);
});

import { cycles } from "../src/edge-graph.mjs";

test("cycles: detects a 2-cycle in calls and reports a sample path", () => {
  const g = buildGraph([E.call("a.mjs", "f", "b.mjs", "g"), E.call("b.mjs", "g", "a.mjs", "f")]);
  const r = cycles(g);
  assert.equal(r.call_cycles.length, 1);
  assert.deepEqual(r.call_cycles[0].members, ["a.mjs#f", "b.mjs#g"]);
  // example is a closed walk: first === last, length 3
  const ex = r.call_cycles[0].example;
  assert.equal(ex[0], ex[ex.length - 1]);
  assert.equal(ex.length, 3);
});

test("cycles: detects a 3-cycle", () => {
  const g = buildGraph([
    E.call("a.mjs", "f", "b.mjs", "g"),
    E.call("b.mjs", "g", "c.mjs", "h"),
    E.call("c.mjs", "h", "a.mjs", "f"),
  ]);
  const r = cycles(g);
  assert.equal(r.call_cycles.length, 1);
  assert.equal(r.call_cycles[0].members.length, 3);
});

test("cycles: acyclic graph yields none", () => {
  const g = buildGraph([E.call("a.mjs", "f", "b.mjs", "g"), E.call("b.mjs", "g", "c.mjs", "h")]);
  const r = cycles(g);
  assert.deepEqual(r.call_cycles, []);
  assert.deepEqual(r.import_cycles, []);
});

test("cycles: self-recursion is excluded, not reported", () => {
  const g = buildGraph([E.call("a.mjs", "f", "a.mjs", "f")]);
  const r = cycles(g);
  assert.deepEqual(r.call_cycles, []);
  assert.equal(r.excluded_self_recursive, 1);
});

test("cycles: import cycles separate from call cycles", () => {
  const g = buildGraph([E.imp("a.mjs", "b.mjs"), E.imp("b.mjs", "a.mjs")]);
  const r = cycles(g);
  assert.equal(r.import_cycles.length, 1);
  assert.deepEqual(r.call_cycles, []);
});
