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
