import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/edge-graph.mjs";
import { pathBetween } from "../src/edge-graph.mjs";

// --- edge-graph helpers (mirror edge-graph.test.mjs pattern) ---
const E = {
  call: (fp, fs, tp, ts) => ({ kind: "calls", conf: "resolved", from_path: fp, from_symbol: fs, to_path: tp, to_symbol: ts, candidates: [] }),
};

// ─── pathBetween unit tests ───────────────────────────────────────────────────

test("pathBetween: linear A→B→C returns [A,B,C]", () => {
  const g = buildGraph([E.call("a.mjs", "f", "b.mjs", "g"), E.call("b.mjs", "g", "c.mjs", "h")]);
  const p = pathBetween(g, ["a.mjs#f"], new Set(["c.mjs#h"]));
  assert.deepEqual(p, ["a.mjs#f", "b.mjs#g", "c.mjs#h"]);
});

test("pathBetween: direct edge A→B returns [A,B]", () => {
  const g = buildGraph([E.call("a.mjs", "f", "b.mjs", "g")]);
  const p = pathBetween(g, ["a.mjs#f"], new Set(["b.mjs#g"]));
  assert.deepEqual(p, ["a.mjs#f", "b.mjs#g"]);
});

test("pathBetween: unreachable returns null", () => {
  const g = buildGraph([E.call("a.mjs", "f", "b.mjs", "g")]);
  const p = pathBetween(g, ["a.mjs#f"], new Set(["c.mjs#h"]));
  assert.equal(p, null);
});

test("pathBetween: startKey ∈ endKeys returns [thatKey]", () => {
  const g = buildGraph([E.call("a.mjs", "f", "b.mjs", "g")]);
  const p = pathBetween(g, ["a.mjs#f"], new Set(["a.mjs#f"]));
  assert.deepEqual(p, ["a.mjs#f"]);
});

test("pathBetween: branch picks the shorter route", () => {
  // A→B→D (len 2)  AND  A→C→E→D (len 3) — shortest is A→B→D
  const g = buildGraph([
    E.call("a.mjs", "f", "b.mjs", "g"),
    E.call("b.mjs", "g", "d.mjs", "z"),
    E.call("a.mjs", "f", "c.mjs", "x"),
    E.call("c.mjs", "x", "e.mjs", "y"),
    E.call("e.mjs", "y", "d.mjs", "z"),
  ]);
  const p = pathBetween(g, ["a.mjs#f"], new Set(["d.mjs#z"]));
  assert.deepEqual(p, ["a.mjs#f", "b.mjs#g", "d.mjs#z"]);
});

test("pathBetween: multi-source multi-target — returns shortest across all pairs", () => {
  // starts: [a#f, b#g]  ends: {c#h, d#z}
  // a#f → c#h (len 1) is the shortest
  const g = buildGraph([
    E.call("a.mjs", "f", "c.mjs", "h"),
    E.call("b.mjs", "g", "x.mjs", "q"),
    E.call("x.mjs", "q", "d.mjs", "z"),
  ]);
  const p = pathBetween(g, ["a.mjs#f", "b.mjs#g"], new Set(["c.mjs#h", "d.mjs#z"]));
  assert.deepEqual(p, ["a.mjs#f", "c.mjs#h"]);
});

test("pathBetween: maxDepth cutoff returns null when only path exceeds it", () => {
  // A→B→C (depth 2); with maxDepth:1 only neighbors at depth 1 (B) are visited, C not reached
  const g = buildGraph([E.call("a.mjs", "f", "b.mjs", "g"), E.call("b.mjs", "g", "c.mjs", "h")]);
  const p = pathBetween(g, ["a.mjs#f"], new Set(["c.mjs#h"]), { maxDepth: 1 });
  assert.equal(p, null);
});

test("pathBetween: maxDepth=1 reaches a direct neighbor", () => {
  const g = buildGraph([E.call("a.mjs", "f", "b.mjs", "g")]);
  const p = pathBetween(g, ["a.mjs#f"], new Set(["b.mjs#g"]), { maxDepth: 1 });
  assert.deepEqual(p, ["a.mjs#f", "b.mjs#g"]);
});

test("pathBetween: cycle A→B→A→C does not infinite-loop and finds A→B→C if exists", () => {
  // A#f → B#g → A#f (cycle) and B#g → C#h
  const g = buildGraph([
    E.call("a.mjs", "f", "b.mjs", "g"),
    E.call("b.mjs", "g", "a.mjs", "f"),  // back-edge
    E.call("b.mjs", "g", "c.mjs", "h"),
  ]);
  const p = pathBetween(g, ["a.mjs#f"], new Set(["c.mjs#h"]));
  assert.deepEqual(p, ["a.mjs#f", "b.mjs#g", "c.mjs#h"]);
});

test("pathBetween: empty graph returns null", () => {
  const g = buildGraph([]);
  const p = pathBetween(g, ["a.mjs#f"], new Set(["b.mjs#g"]));
  assert.equal(p, null);
});

test("pathBetween: start not in graph returns null", () => {
  const g = buildGraph([E.call("x.mjs", "p", "y.mjs", "q")]);
  const p = pathBetween(g, ["a.mjs#f"], new Set(["y.mjs#q"]));
  assert.equal(p, null);
});

test("pathBetween: multi-source with one start directly in endKeys returns single-element path", () => {
  const g = buildGraph([E.call("a.mjs", "f", "b.mjs", "g")]);
  // b#g is both a start and an end
  const p = pathBetween(g, ["a.mjs#f", "b.mjs#g"], new Set(["b.mjs#g"]));
  assert.deepEqual(p, ["b.mjs#g"]);
});

// ─── runPath unit tests ───────────────────────────────────────────────────────

import { openStore } from "../src/store.mjs";
import { runPath } from "../bin/gtir.mjs";

function tmpCfg(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gtir-path-"));
  // indexDir must match what loadConfig(dir) produces so runPath resolves the same store
  return { indexDir: join(dir, ".gtir", "index.lance"), model: "qwen3", _root: dir, ...extra };
}
const chunk = (id, path, ls, le, text) => ({ id, path, line_start: ls, line_end: le, language: "js", text, embedding: [0.1, 0.2], mtime_ms: 1, content_hash: "h" + id });
const call = (fp, fs, tp, ts) => ({ kind: "calls", conf: "resolved", from_path: fp, from_lines: "1", from_symbol: fs, to_path: tp, to_lines: "1", to_symbol: ts, candidates: [], content_hash: "h" });

async function seedThreeHop(cfg) {
  const store = await openStore(cfg);
  await store.upsertRows([
    chunk("1", "a.mjs", 1, 3, "function f(){ g(); }"),
    chunk("2", "b.mjs", 1, 3, "function g(){ h(); }"),
    chunk("3", "c.mjs", 1, 3, "function h(){}"),
  ]);
  await store.upsertEdges([call("a.mjs", "f", "b.mjs", "g"), call("b.mjs", "g", "c.mjs", "h")]);
}

test("runPath: f→h returns path containing f, g, h in order", async () => {
  const cfg = tmpCfg();
  try {
    await seedThreeHop(cfg);
    const r = await runPath({ repo: cfg._root, from: "f", to: "h" });
    assert.equal(r.error, undefined);
    assert.ok(Array.isArray(r.path));
    assert.equal(r.path.length, 3);
    // node keys: a.mjs#f → b.mjs#g → c.mjs#h
    assert.ok(r.path[0].includes("f"), `first node should include 'f', got ${r.path[0]}`);
    assert.ok(r.path[1].includes("g"), `middle node should include 'g', got ${r.path[1]}`);
    assert.ok(r.path[2].includes("h"), `last node should include 'h', got ${r.path[2]}`);
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("runPath: direct f→g returns 2-node path", async () => {
  const cfg = tmpCfg();
  try {
    await seedThreeHop(cfg);
    const r = await runPath({ repo: cfg._root, from: "f", to: "g" });
    assert.equal(r.error, undefined);
    assert.equal(r.path.length, 2);
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("runPath: unreachable to returns notFound:false, path:null", async () => {
  const cfg = tmpCfg();
  try {
    await seedThreeHop(cfg);
    const r = await runPath({ repo: cfg._root, from: "h", to: "f" }); // h doesn't call f
    assert.equal(r.error, undefined);
    assert.equal(r.path, null);
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("runPath: unknown from symbol returns error", async () => {
  const cfg = tmpCfg();
  try {
    await seedThreeHop(cfg);
    const r = await runPath({ repo: cfg._root, from: "nope", to: "h" });
    assert.ok(r.error, "should have an error");
    assert.match(r.error, /not found/i);
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("runPath: unknown to symbol returns error", async () => {
  const cfg = tmpCfg();
  try {
    await seedThreeHop(cfg);
    const r = await runPath({ repo: cfg._root, from: "f", to: "nope" });
    assert.ok(r.error, "should have an error");
    assert.match(r.error, /not found/i);
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("runPath: no edge index returns error", async () => {
  const cfg = tmpCfg();
  try {
    const store = await openStore(cfg);
    await store.upsertRows([chunk("1", "a.mjs", 1, 2, "function f(){}")]);
    // no edges stored
    const r = await runPath({ repo: cfg._root, from: "f", to: "f" });
    assert.ok(r.error, "should have an error");
    assert.match(r.error, /no edge index/i);
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("runPath: from===to same node returns single-element path", async () => {
  const cfg = tmpCfg();
  try {
    await seedThreeHop(cfg);
    const r = await runPath({ repo: cfg._root, from: "f", to: "f" });
    assert.equal(r.error, undefined);
    assert.equal(r.path.length, 1);
    assert.ok(r.path[0].includes("f"));
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("runPath: fromPath filter narrows to correct definition site", async () => {
  const cfg = tmpCfg();
  try {
    // two files both define 'entry', each call different targets
    const store = await openStore(cfg);
    await store.upsertRows([
      chunk("1", "p.mjs", 1, 3, "function entry(){ target_p(); }"),
      chunk("2", "q.mjs", 1, 3, "function entry(){ target_q(); }"),
      chunk("3", "p.mjs", 5, 7, "function target_p(){}"),
      chunk("4", "q.mjs", 5, 7, "function target_q(){}"),
    ]);
    await store.upsertEdges([
      call("p.mjs", "entry", "p.mjs", "target_p"),
      call("q.mjs", "entry", "q.mjs", "target_q"),
    ]);
    // Without fromPath: entry is ambiguous — collect all, try all. Both reach their own target.
    // With fromPath: only p.mjs entry is considered, so only path to target_p is valid.
    const r = await runPath({ repo: cfg._root, from: "entry", to: "target_p", fromPath: "p.mjs" });
    assert.equal(r.error, undefined);
    assert.ok(r.path !== null);
    assert.ok(r.path[0].startsWith("p.mjs"), `expected p.mjs start, got ${r.path[0]}`);
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});
