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
