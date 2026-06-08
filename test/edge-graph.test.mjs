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

import { classifyEntrypoint, orphans } from "../src/edge-graph.mjs";

test("classifyEntrypoint: plain symbol is not an entrypoint", () => {
  assert.equal(classifyEntrypoint("helper", "src/util.mjs", "function helper() {}").entrypoint, false);
});

test("classifyEntrypoint: export marker, bin/ path, test path, main name, go-cap", () => {
  assert.equal(classifyEntrypoint("foo", "src/a.mjs", "export function foo() {}").entrypoint, true);
  assert.equal(classifyEntrypoint("main", "bin/cli.mjs", "function main() {}").entrypoint, true);
  assert.equal(classifyEntrypoint("h", "test/a.test.mjs", "function h(){}").entrypoint, true);
  assert.equal(classifyEntrypoint("run", "src/a.mjs", "function run(){}").entrypoint, true);
  assert.equal(classifyEntrypoint("Handler", "pkg/srv.go", "func Handler(){}").entrypoint, true);
});

test("orphans: unreferenced plain symbol is likely_dead; exported is entrypoint", () => {
  // edges: live#a -> live#b (b is referenced). dead is defined but never a target.
  const g = buildGraph([{ kind: "calls", conf: "resolved", from_path: "live.mjs", from_symbol: "a", to_path: "live.mjs", to_symbol: "b", candidates: [] }]);
  const inv = [
    { name: "a", path: "live.mjs", line_start: 1, line_end: 3, text: "function a(){ b(); }" },
    { name: "b", path: "live.mjs", line_start: 5, line_end: 7, text: "function b(){}" },
    { name: "dead", path: "util.mjs", line_start: 1, line_end: 2, text: "function dead(){}" },
    { name: "api", path: "util.mjs", line_start: 4, line_end: 6, text: "export function api(){}" },
  ];
  const r = orphans(inv, g);
  // b is referenced -> neither list. a and dead have no inbound. a is plain -> dead; dead plain -> dead; api exported -> entrypoint.
  assert.deepEqual(r.likely_dead.map((d) => d.symbol).sort(), ["a", "dead"]);
  assert.deepEqual(r.possible_entrypoint.map((d) => d.symbol), ["api"]);
  assert.equal(r.likely_dead.find((d) => d.symbol === "dead").lines, "1-2");
});

test("orphans: a zero-inbound symbol that calls external code is external-facing, not dead", () => {
  const inv = [
    { name: "EffectRender", path: "plugin.cpp", line_start: 1, line_end: 9, text: "void EffectRender(){ SDK_Begin(); }" },
    { name: "deadHelper", path: "util.cpp", line_start: 1, line_end: 2, text: "int deadHelper(){ return 0; }" },
  ];
  const g = buildGraph([
    { kind: "calls", conf: "external", from_path: "plugin.cpp", from_symbol: "EffectRender", to_path: null, to_symbol: null, ref_name: "SDK_Begin", candidates: [] },
  ]);
  const r = orphans(inv, g);
  assert.deepEqual(r.likely_dead.map((d) => d.symbol), ["deadHelper"]);
  const ext = r.possible_entrypoint.find((d) => d.symbol === "EffectRender");
  assert.ok(ext, "EffectRender should be a possible_entrypoint");
  assert.equal(ext.reason, "external-facing");
});

test("orphans: classifyEntrypoint reason still wins over external-facing", () => {
  const inv = [{ name: "api", path: "lib.ts", line_start: 1, line_end: 3, text: "export function api(){ ext(); }" }];
  const g = buildGraph([
    { kind: "calls", conf: "external", from_path: "lib.ts", from_symbol: "api", to_path: null, to_symbol: null, ref_name: "ext", candidates: [] },
  ]);
  const r = orphans(inv, g);
  assert.equal(r.possible_entrypoint.find((d) => d.symbol === "api").reason, "exported");
});

test("orphans: includeAmbiguous suppresses flag when ambiguous inbound exists", () => {
  const g = buildGraph([
    { kind: "calls", conf: "ambiguous", from_path: "x.mjs", from_symbol: "c", to_path: null, to_symbol: null, ref_name: "maybe", candidates: ["util.mjs"] },
  ], { includeAmbiguous: true });
  const inv = [{ name: "maybe", path: "util.mjs", line_start: 1, line_end: 2, text: "function maybe(){}" }];
  assert.deepEqual(orphans(inv, g, { includeAmbiguous: true }).likely_dead, []);
});

import { degreeMap } from "../src/edge-graph.mjs";

test("degreeMap: call-degree keyed by symbol; import in-degree by file", () => {
  const g = buildGraph([
    E.call("a.mjs", "f", "b.mjs", "g"),   // g gains in-degree 1
    E.call("c.mjs", "x", "b.mjs", "g"),   // g gains in-degree 1 -> total 2
    E.imp("d.mjs", "b.mjs"),              // b.mjs imported once
    E.imp("e.mjs", "b.mjs"),              // b.mjs imported twice
  ]);
  const call = degreeMap(g, { kinds: ["calls"] });
  assert.equal(call.get("b.mjs#g"), 2);        // 2 incoming calls
  assert.equal(call.get("a.mjs#f"), 1);        // 1 outgoing call
  const imp = degreeMap(g, { kinds: ["imports"], direction: "in" });
  assert.equal(imp.get("b.mjs"), 2);           // imported by d and e
  assert.equal(imp.get("d.mjs"), undefined);   // d has only out, in-only map omits it
});

test("degreeMap: empty graph yields empty map", () => {
  assert.equal(degreeMap(buildGraph([])).size, 0);
});

test("buildGraph: externalOut records nodes that emit an external call", () => {
  const g = buildGraph([
    { kind: "calls", conf: "external", from_path: "a.cpp", from_symbol: "f", to_path: null, to_symbol: null, ref_name: "SDK_Do", candidates: [] },
    { kind: "calls", conf: "resolved", from_path: "a.cpp", from_symbol: "g", to_path: "b.cpp", to_symbol: "h", candidates: [] },
    { kind: "calls", conf: "external", from_path: "a.cpp", from_symbol: null, to_path: null, to_symbol: null, ref_name: "topLevelExt", candidates: [] },
  ]);
  assert.ok(g.externalOut.has("a.cpp#f"));
  assert.ok(!g.externalOut.has("a.cpp#g"));
  assert.ok(g.externalOut.has("a.cpp"));
});

test("buildGraph: inferred call edge wires like resolved (one link, not fan-out)", () => {
  const g = buildGraph([{ kind: "calls", conf: "inferred", from_path: "a.mjs", from_symbol: "f",
    to_path: "b.mjs", to_symbol: "g", ref_name: "g", candidates: [], score: 0.71 }]);
  assert.deepEqual([...g.fwd.get("a.mjs#f")], ["b.mjs#g"]);
  assert.ok(g.rev.get("b.mjs#g").has("a.mjs#f"));
  assert.equal(g.edgeList.length, 1);
  assert.equal(g.edgeList[0].conf, "inferred");
  assert.equal(degreeMap(g, { kinds: ["calls"] }).get("b.mjs#g"), 1);
});
