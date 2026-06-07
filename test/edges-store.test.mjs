import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.mjs";

function tmpCfg() {
  const dir = mkdtempSync(join(tmpdir(), "gtir-edges-"));
  return { indexDir: join(dir, ".gtir"), _root: dir };
}

const sample = [
  { kind: "calls", conf: "resolved", from_path: "mw.ts", from_lines: "12", from_symbol: null,
    to_path: "token.ts", to_lines: "48-79", to_symbol: "verifyToken", candidates: [], content_hash: "h1" },
  { kind: "calls", conf: "ambiguous", from_path: "x.ts", from_lines: "5", from_symbol: null,
    to_path: null, to_lines: null, to_symbol: null, candidates: ["a.ts", "b.ts"], content_hash: "h2" },
];

test("upsertEdges then loadEdges round-trips rows incl. candidates", async () => {
  const cfg = tmpCfg();
  try {
    const store = await openStore(cfg);
    await store.upsertEdges(sample);
    const rows = await store.loadEdges();
    assert.equal(rows.length, 2);
    const amb = rows.find((r) => r.conf === "ambiguous");
    assert.deepEqual(amb.candidates, ["a.ts", "b.ts"]);
    assert.equal(rows.find((r) => r.conf === "resolved").to_symbol, "verifyToken");
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("upsertEdges replaces a file's edges (delete-then-add by from_path)", async () => {
  const cfg = tmpCfg();
  try {
    const store = await openStore(cfg);
    await store.upsertEdges(sample);
    await store.upsertEdges([{ ...sample[0], to_symbol: "verifyTokenV2" }]);
    const rows = await store.loadEdges();
    assert.ok(rows.some((r) => r.to_symbol === "verifyTokenV2"));
    assert.ok(!rows.some((r) => r.to_symbol === "verifyToken"));
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("evictEdgePaths drops a file's edges", async () => {
  const cfg = tmpCfg();
  try {
    const store = await openStore(cfg);
    await store.upsertEdges(sample);
    await store.evictEdgePaths(["x.ts"]);
    const rows = await store.loadEdges();
    assert.ok(!rows.some((r) => r.from_path === "x.ts"));
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("edge ref_name round-trips through the store", async () => {
  const cfg = tmpCfg();
  try {
    const store = await openStore(cfg);
    await store.upsertEdges([{
      kind: "calls", conf: "external", from_path: "a.ts", from_lines: "5", from_symbol: "f",
      to_path: null, to_lines: null, to_symbol: null, ref_name: "Error", candidates: [], content_hash: "h1",
    }]);
    const [e] = await store.loadEdges();
    assert.equal(e.ref_name, "Error");
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});

test("edge upserted without ref_name coerces undefined -> '' -> null", async () => {
  // Not a real schema-less old table — this exercises the toEdgeRow("") + fromEdgeRow(null) coercion
  // that makes a missing ref_name degrade cleanly. A genuinely old table is handled by `gtir index --rebuild`.
  const cfg = tmpCfg();
  try {
    const store = await openStore(cfg);
    await store.upsertEdges([{
      kind: "calls", conf: "resolved", from_path: "a.ts", from_lines: "5", from_symbol: "f",
      to_path: "b.ts", to_lines: "10", to_symbol: "g", candidates: [], content_hash: "h2",
    }]);
    const [e] = await store.loadEdges();
    assert.equal(e.ref_name, null);
  } finally { rmSync(cfg._root, { recursive: true, force: true }); }
});
