import { test } from "node:test";
import assert from "node:assert/strict";
import { modularity } from "../src/communities.mjs";

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
