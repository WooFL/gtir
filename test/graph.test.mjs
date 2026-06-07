import { test } from "node:test";
import assert from "node:assert/strict";
import { mapEdges, applyFilters, egoGraph, capByDegree, rollupToFiles, buildGraph, worstConf, renderHtml } from "../src/graph.mjs";

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

// chain: f -> g -> h  (three code nodes, two edges)
const CHAIN = mapEdges([
  E({ from_symbol: "f", from_path: "a.ts", to_symbol: "g", to_path: "b.ts", ref_name: "g" }),
  E({ from_symbol: "g", from_path: "b.ts", to_symbol: "h", to_path: "c.ts", ref_name: "h" }),
]);

test("egoGraph: depth 1 from f keeps f and g, drops h", () => {
  const g = egoGraph(CHAIN, "f", 1);
  const ids = g.nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, ["f\x00a.ts", "g\x00b.ts"].sort());
  assert.equal(g.edges.length, 1);
});

test("egoGraph: depth 2 from f reaches h", () => {
  const g = egoGraph(CHAIN, "f", 2);
  assert.equal(g.nodes.length, 3);
  assert.equal(g.edges.length, 2);
});

test("egoGraph: traversal is undirected (focus on h still finds f at depth 2)", () => {
  const g = egoGraph(CHAIN, "h", 2);
  assert.ok(g.nodes.some((n) => n.id === "f\x00a.ts"));
});

test("egoGraph: unknown focus yields an empty graph", () => {
  const g = egoGraph(CHAIN, "nope", 2);
  assert.equal(g.nodes.length, 0);
  assert.equal(g.edges.length, 0);
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

test("capByDegree: drops lowest-degree nodes and reports truncation", () => {
  // hub h connects to a,b,c; isolated pair p-q. Cap to 4 nodes should drop the 2 lowest-degree.
  const g = mapEdges([
    E({ from_symbol: "h", from_path: "h.ts", to_symbol: "a", to_path: "a.ts", ref_name: "a" }),
    E({ from_symbol: "h", from_path: "h.ts", to_symbol: "b", to_path: "b.ts", ref_name: "b" }),
    E({ from_symbol: "h", from_path: "h.ts", to_symbol: "c", to_path: "c.ts", ref_name: "c" }),
    E({ from_symbol: "p", from_path: "p.ts", to_symbol: "q", to_path: "q.ts", ref_name: "q" }),
  ]);
  assert.equal(g.nodes.length, 6);
  const capped = capByDegree(g, 4);
  assert.ok(capped.nodes.length <= 4);
  assert.equal(capped.truncated, true);
  assert.equal(capped.dropped, g.nodes.length - capped.nodes.length);
  assert.equal(capped.nodes.length, 4);
  // the hub (highest degree) survives
  assert.ok(capped.nodes.some((n) => n.id === "h\x00h.ts"));
});

test("capByDegree: under the cap is a no-op", () => {
  const g = mapEdges([E()]);
  const capped = capByDegree(g, 400);
  assert.equal(capped.truncated, false);
  assert.equal(capped.dropped, 0);
  assert.equal(capped.nodes.length, 2);
});

test("rollupToFiles: collapses symbol nodes to files and merges parallel edges", () => {
  const g = mapEdges([
    E({ from_symbol: "f", from_path: "a.ts", to_symbol: "g", to_path: "b.ts", ref_name: "g" }),
    E({ from_symbol: "h", from_path: "a.ts", to_symbol: "i", to_path: "b.ts", ref_name: "i" }),
  ]);
  const r = rollupToFiles(g);
  assert.deepEqual(r.nodes.map((n) => n.id).sort(), ["a.ts", "b.ts"]);
  assert.equal(r.edges.length, 1);
  assert.equal(r.edges[0].count, 2);
});

test("rollupToFiles: two resolved edges merge into one resolved edge", () => {
  const g = mapEdges([
    E({ from_symbol: "f", from_path: "a.ts", to_symbol: "g", to_path: "b.ts", conf: "resolved", ref_name: "g" }),
    E({ from_symbol: "h", from_path: "a.ts", to_symbol: "i", to_path: "b.ts", conf: "resolved", ref_name: "i" }),
  ]);
  const r = rollupToFiles(g);
  assert.equal(r.edges.length, 1);
  assert.equal(r.edges[0].conf, "resolved");
});

test("worstConf: ambiguous dominates external dominates resolved", () => {
  assert.equal(worstConf("resolved", "ambiguous"), "ambiguous");
  assert.equal(worstConf("external", "resolved"), "external");
  assert.equal(worstConf("ambiguous", "external"), "ambiguous");
});

test("buildGraph: end-to-end resolved chain, no opts", () => {
  const g = buildGraph([
    E({ from_symbol: "f", from_path: "a.ts", to_symbol: "g", to_path: "b.ts", ref_name: "g" }),
  ]);
  assert.equal(g.nodes.length, 2);
  assert.equal(g.edges.length, 1);
  assert.equal(g.truncated, false);
  assert.equal(g.dropped, 0);
});

test("buildGraph: focus prunes, rollup collapses, cap bounds", () => {
  const rows = [
    E({ from_symbol: "f", from_path: "a.ts", to_symbol: "g", to_path: "b.ts", ref_name: "g" }),
    E({ from_symbol: "g", from_path: "b.ts", to_symbol: "h", to_path: "c.ts", ref_name: "h" }),
    E({ from_symbol: "z", from_path: "z.ts", to_symbol: "y", to_path: "y.ts", ref_name: "y" }), // disjoint
  ];
  const focused = buildGraph(rows, { focus: "f", depth: 1 });
  assert.ok(!focused.nodes.some((n) => n.id.includes("z.ts")));
  const rolled = buildGraph(rows, { rollup: true });
  assert.ok(rolled.nodes.every((n) => !n.id.includes("\x00")));
});

test("renderHtml: self-contained — inlines d3, embeds data, no external refs", () => {
  const g = buildGraph([E({ from_symbol: "verifyToken", from_path: "auth/jwt.ts", to_symbol: "signToken", to_path: "auth/jwt.ts", ref_name: "signToken" })]);
  const html = renderHtml({ nodes: g.nodes, edges: g.edges, meta: { truncated: false, dropped: 0 } }, "/* D3SRC */ var d3={};");
  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes("/* D3SRC */"));            // inlined d3 present
  assert.ok(html.includes("__GTIR_GRAPH__"));          // data hook present
  assert.ok(html.includes("verifyToken"));             // a node label present
  assert.ok(!html.includes("<script src"));            // nothing fetched
  assert.ok(!html.includes("//unpkg") && !html.includes("//cdn"));
});

test("renderHtml: shows truncation note when capped", () => {
  const html = renderHtml({ nodes: [], edges: [], meta: { truncated: true, dropped: 12 } }, "var d3={};");
  assert.ok(html.includes("dropped 12"));
});
