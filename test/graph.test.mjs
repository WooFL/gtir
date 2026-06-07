import { test } from "node:test";
import assert from "node:assert/strict";
import { mapEdges, applyFilters } from "../src/graph.mjs";

// Edge factory matching the store.loadEdges() row shape.
const E = (o = {}) => ({
  kind: "calls", conf: "resolved",
  from_path: "a.ts", from_lines: "5", from_symbol: "f",
  to_path: "b.ts", to_lines: "10", to_symbol: "g",
  ref_name: "g", candidates: [], content_hash: "h", ...o,
});

test("mapEdges: resolved call makes two code nodes + one edge", () => {
  const { nodes, edges } = mapEdges([E()]);
  const ids = nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["f\x00a.ts", "g\x00b.ts"].sort());
  assert.equal(nodes.find((n) => n.id === "f\x00a.ts").cls, "code");
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0], { source: "f\x00a.ts", target: "g\x00b.ts", kind: "calls", conf: "resolved" });
});

test("mapEdges: external call target is a named grey node", () => {
  const { nodes } = mapEdges([E({ conf: "external", to_path: null, to_symbol: null, ref_name: "Error" })]);
  const ext = nodes.find((n) => n.id === "ext:Error");
  assert.ok(ext);
  assert.equal(ext.cls, "external");
  assert.equal(ext.label, "Error");
});

test("mapEdges: ambiguous target merges candidates by name", () => {
  const a = E({ conf: "ambiguous", to_path: null, to_symbol: null, ref_name: "log", candidates: ["x.ts"] });
  const b = E({ from_symbol: "h", conf: "ambiguous", to_path: null, to_symbol: null, ref_name: "log", candidates: ["y.ts"] });
  const { nodes } = mapEdges([a, b]);
  const amb = nodes.find((n) => n.id === "amb:log");
  assert.ok(amb);
  assert.equal(amb.cls, "ambiguous");
  assert.deepEqual(amb.candidates.sort(), ["x.ts", "y.ts"]);
});

test("mapEdges: null ref_name degrades to a shared sink", () => {
  const { nodes } = mapEdges([E({ conf: "external", to_path: null, to_symbol: null, ref_name: null })]);
  const ext = nodes.find((n) => n.id === "ext:");
  assert.ok(ext);
  assert.equal(ext.label, "(external)");
});

test("mapEdges: note edge makes [[note]] nodes", () => {
  const { nodes } = mapEdges([E({
    kind: "links", from_path: "notes/a.md", from_symbol: "a",
    to_path: "notes/b.md", to_symbol: "b", ref_name: "b",
  })]);
  const labels = nodes.map((n) => n.label).sort();
  assert.deepEqual(labels, ["[[a]]", "[[b]]"]);
  assert.equal(nodes[0].cls, "note");
});

test("applyFilters: narrows by kind, conf, pathPrefix", () => {
  const rows = [
    E({ kind: "calls", conf: "resolved", from_path: "src/x.ts" }),
    E({ kind: "imports", conf: "external", from_path: "src/x.ts", ref_name: "./z" }),
    E({ kind: "calls", conf: "resolved", from_path: "other/y.ts" }),
  ];
  assert.equal(applyFilters(rows, { kind: ["calls"] }).length, 2);
  assert.equal(applyFilters(rows, { conf: ["external"] }).length, 1);
  assert.equal(applyFilters(rows, { pathPrefix: "src/" }).length, 2);
});
