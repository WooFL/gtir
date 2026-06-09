import { test } from "node:test";
import assert from "node:assert/strict";
import { modularity, leiden, refinePartition } from "../src/communities.mjs";

function adjFrom(edges) { // edges: [a,b] (weight 1) or [a,b,w]
  const adj = new Map();
  const add = (a, b, w) => { if (!adj.has(a)) adj.set(a, new Map()); adj.get(a).set(b, (adj.get(a).get(b) ?? 0) + w); };
  for (const [a, b, w = 1] of edges) { add(a, b, w); add(b, a, w); }
  return adj;
}

const twoTriangles = adjFrom([["a","b"],["b","c"],["a","c"],["d","e"],["e","f"],["d","f"],["c","d"]]);

test("modularity: the 2-community split scores higher than all-in-one", () => {
  const split = new Map([["a",0],["b",0],["c",0],["d",1],["e",1],["f",1]]);
  const one = new Map([["a",0],["b",0],["c",0],["d",0],["e",0],["f",0]]);
  const qSplit = modularity(twoTriangles, split);
  assert.ok(Math.abs(qSplit - 0.3571) < 0.01, `expected ~0.357, got ${qSplit}`);
  assert.ok(qSplit > modularity(twoTriangles, one), "split beats single community");
});

test("modularity: empty graph is 0 (no divide-by-zero)", () => {
  assert.equal(modularity(new Map(), new Map()), 0);
});

test("leiden: two triangles + bridge → exactly 2 communities, abc together, def together", () => {
  const r = leiden(twoTriangles);
  const sc = (x, y) => r.community.get(x) === r.community.get(y);
  assert.equal(new Set(r.community.values()).size, 2);
  assert.ok(sc("a","b") && sc("b","c"), "abc together");
  assert.ok(sc("d","e") && sc("e","f"), "def together");
  assert.notEqual(r.community.get("a"), r.community.get("d"), "abc != def");
  assert.ok(Math.abs(r.modularity - 0.3571) < 0.01, `Q ~0.357, got ${r.modularity}`);
});

test("leiden: a single triangle → 1 community", () => {
  const tri = adjFrom([["a","b"],["b","c"],["a","c"]]);
  assert.equal(new Set(leiden(tri).community.values()).size, 1);
});

test("leiden: two disconnected edges → 2 communities", () => {
  const g = adjFrom([["a","b"],["c","d"]]);
  const r = leiden(g);
  assert.equal(new Set(r.community.values()).size, 2);
  assert.equal(r.community.get("a"), r.community.get("b"));
  assert.notEqual(r.community.get("a"), r.community.get("c"));
});

test("leiden: weight, not just topology, decides the split", () => {
  const g = adjFrom([["a","b",10],["b","c",1],["c","d",10]]);
  const r = leiden(g);
  assert.equal(r.community.get("a"), r.community.get("b"));
  assert.equal(r.community.get("c"), r.community.get("d"));
  assert.notEqual(r.community.get("a"), r.community.get("c"));
});

test("leiden: deterministic (same input → identical partition)", () => {
  const a = leiden(twoTriangles).community, b = leiden(twoTriangles).community;
  assert.deepEqual([...a].sort(), [...b].sort());
});

test("leiden: empty graph → empty partition, modularity 0", () => {
  const r = leiden(new Map());
  assert.equal(r.community.size, 0);
  assert.equal(r.modularity, 0);
});

test("refinePartition splits an internally-disconnected community into connected sub-communities", () => {
  const adj = adjFrom([["x","y"],["z","w"]]);
  const community = new Map([["x",0],["y",0],["z",0],["w",0]]);
  const refined = refinePartition(adj, community);
  assert.equal(new Set(refined.values()).size, 2, "split into 2 connected sub-communities");
  assert.equal(refined.get("x"), refined.get("y"), "x,y together");
  assert.equal(refined.get("z"), refined.get("w"), "z,w together");
  assert.notEqual(refined.get("x"), refined.get("z"), "the two halves separated");
});

test("refinePartition leaves an already-connected community intact (1 sub-community)", () => {
  const adj = adjFrom([["a","b"],["b","c"],["a","c"]]);
  const community = new Map([["a",0],["b",0],["c",0]]);
  assert.equal(new Set(refinePartition(adj, community).values()).size, 1);
});
