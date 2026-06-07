import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.mjs";
import { buildSymbolInventory } from "../src/graph-queries.mjs";

function tmpCfg(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gtir-gq-"));
  return { indexDir: join(dir, ".gtir"), model: "qwen3", _root: dir, ...extra };
}
const chunk = (id, path, ls, le, text) => ({ id, path, line_start: ls, line_end: le, language: "js", text, embedding: [0.1, 0.2], mtime_ms: 1, content_hash: "h" + id });

test("buildSymbolInventory (code): declared symbols indexed by name, deduped per (path,name)", async () => {
  const cfg = tmpCfg();
  try {
    const store = await openStore(cfg);
    await store.upsertRows([
      chunk("1", "a.mjs", 1, 3, "function foo(){}"),
      chunk("2", "a.mjs", 5, 7, "function bar(){}"),
      chunk("3", "b.mjs", 1, 2, "function foo(){}"),
    ]);
    const inv = await buildSymbolInventory(store, "code");
    assert.equal(inv.flat.length, 3);
    assert.deepEqual(inv.byName.get("foo").map((d) => d.path).sort(), ["a.mjs", "b.mjs"]);
    assert.equal(inv.byName.get("bar")[0].line_start, 5);
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("buildSymbolInventory (notes): one entry per note file, name = basename", async () => {
  const cfg = tmpCfg({ model: "nomic-embed-text" });
  try {
    const store = await openStore(cfg);
    await store.upsertRows([chunk("1", "notes/Alpha.md", 1, 9, "body"), chunk("2", "notes/Alpha.md", 10, 12, "more")]);
    const inv = await buildSymbolInventory(store, "notes");
    assert.equal(inv.flat.length, 1);
    assert.equal(inv.flat[0].name, "Alpha");
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

import { impactQuery, orphansQuery, cyclesQuery } from "../src/graph-queries.mjs";

// Helper: a code repo store with chunks + edges already populated.
async function seedRepo(cfg) {
  const store = await openStore(cfg);
  await store.upsertRows([
    chunk("1", "a.mjs", 1, 3, "function f(){ g(); }"),
    chunk("2", "b.mjs", 1, 3, "function g(){ h(); }"),
    chunk("3", "c.mjs", 1, 3, "function h(){}"),
    chunk("4", "u.mjs", 1, 2, "function dead(){}"),
  ]);
  const call = (fp, fs, tp, ts) => ({ kind: "calls", conf: "resolved", from_path: fp, from_lines: "1", from_symbol: fs, to_path: tp, to_lines: "1", to_symbol: ts, candidates: [], content_hash: "h" });
  await store.upsertEdges([
    call("a.mjs", "f", "b.mjs", "g"),
    call("b.mjs", "g", "c.mjs", "h"),
    // import cycle p <-> q
    { kind: "imports", conf: "resolved", from_path: "p.mjs", from_lines: "1", from_symbol: "./q", to_path: "q.mjs", to_lines: "0-0", to_symbol: null, candidates: [], content_hash: "h" },
    { kind: "imports", conf: "resolved", from_path: "q.mjs", from_lines: "1", from_symbol: "./p", to_path: "p.mjs", to_lines: "0-0", to_symbol: null, candidates: [], content_hash: "h" },
  ]);
}

test("impactQuery upstream resolves a symbol and returns transitive callers", async () => {
  const cfg = tmpCfg();
  try {
    await seedRepo(cfg);
    const r = await impactQuery(cfg, { symbol: "h" });
    assert.equal(r.symbol, "h");
    assert.equal(r.direction, "upstream");
    assert.deepEqual(r.nodes.map((n) => n.symbol).sort(), ["f", "g"]);
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("impactQuery: unknown symbol errors; no edges errors", async () => {
  const cfg = tmpCfg();
  try {
    await seedRepo(cfg);
    assert.match((await impactQuery(cfg, { symbol: "nope" })).error, /not found/);
    const empty = tmpCfg();
    try {
      const s = await openStore(empty);
      await s.upsertRows([chunk("1", "a.mjs", 1, 2, "function f(){}")]); // chunks but no edges table
      assert.match((await impactQuery(empty, { symbol: "f" })).error, /no edge index/);
    } finally { rmSync(empty._root, { recursive: true, force: true }); }
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("impactQuery: symbol defined in >1 file without --path is ambiguous", async () => {
  const cfg = tmpCfg();
  try {
    const store = await openStore(cfg);
    await store.upsertRows([chunk("1", "a.mjs", 1, 2, "function dup(){}"), chunk("2", "b.mjs", 1, 2, "function dup(){}")]);
    await store.upsertEdges([{ kind: "calls", conf: "resolved", from_path: "a.mjs", from_lines: "1", from_symbol: "dup", to_path: "a.mjs", to_lines: "1", to_symbol: "dup", candidates: [], content_hash: "h" }]);
    const r = await impactQuery(cfg, { symbol: "dup" });
    assert.equal(r.ambiguous.length, 2);
    const r2 = await impactQuery(cfg, { symbol: "dup", path: "a.mjs" });
    assert.equal(r2.symbol, "dup");
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("orphansQuery flags the dead function, not the call chain", async () => {
  const cfg = tmpCfg();
  try {
    await seedRepo(cfg);
    const r = await orphansQuery(cfg);
    assert.ok(r.likely_dead.some((d) => d.symbol === "dead"));
    assert.ok(!r.likely_dead.some((d) => d.symbol === "h")); // h is called
    assert.equal(r.counts.likely_dead, r.likely_dead.length);
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("cyclesQuery finds the import cycle", async () => {
  const cfg = tmpCfg();
  try {
    await seedRepo(cfg);
    const r = await cyclesQuery(cfg);
    assert.equal(r.import_cycles.length, 1);
    assert.deepEqual(r.import_cycles[0].members, ["p.mjs", "q.mjs"]);
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});
