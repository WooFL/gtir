import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/config.mjs";
import { retrievalQuality } from "../src/context.mjs";

test("context config defaults exist", () => {
  assert.equal(DEFAULTS.contextK, 5);
  assert.equal(DEFAULTS.contextMarginHigh, 0.30);
  assert.equal(DEFAULTS.contextMarginLow, 0.08);
});

test("retrievalQuality query mode: dominant top hit -> high", () => {
  const r = retrievalQuality([{ score: 0.05, vec_rank: 1 }, { score: 0.02 }], "query");
  assert.equal(r.retrieval_quality, "high");
  assert.equal(r.best_guesses, false);
});

test("retrievalQuality query mode: near-tied -> low + best_guesses + note", () => {
  const r = retrievalQuality([{ score: 0.031 }, { score: 0.030 }], "query");
  assert.equal(r.retrieval_quality, "low");
  assert.equal(r.best_guesses, true);
  assert.match(r.note, /verify/);
});

test("retrievalQuality query mode: empty -> low", () => {
  assert.equal(retrievalQuality([], "query").retrieval_quality, "low");
});

test("retrievalQuality query mode: mid-margin -> medium", () => {
  const r = retrievalQuality([{ score: 0.04, vec_rank: 2 }, { score: 0.035 }], "query");
  assert.equal(r.retrieval_quality, "medium"); // margin 0.125 -> between 0.08 and 0.30
});

test("retrievalQuality targets mode: resolution success drives quality", () => {
  assert.equal(retrievalQuality([{ path: "a" }, { path: "b" }], "targets").retrieval_quality, "high");
  assert.equal(retrievalQuality([{ error: "not found" }], "targets").retrieval_quality, "low");
  assert.equal(retrievalQuality([{ path: "a" }, { error: "not found" }], "targets").retrieval_quality, "medium");
});

import { before as _before, after as _after } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { buildIndex, indexEdges } from "../src/indexer.mjs";
import { buildContext } from "../src/context.mjs";

const DIM = 16;
const evec = (t) => { const v = Array(DIM).fill(0.01); for (let i = 0; i < t.length; i++) v[i % DIM] += t.charCodeAt(i) % 5; return v; };
let _realFetch;
_before(() => {
  _realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    if (u.pathname === "/api/embed") {
      const input = JSON.parse(opts.body || "{}").input;
      const arr = Array.isArray(input) ? input : [input];
      return { ok: true, status: 200, json: async () => ({ embeddings: arr.map(evec) }), text: async () => "" };
    }
    if (u.pathname === "/api/version") return { ok: true, status: 200, json: async () => ({ version: "stub" }), text: async () => "" };
    if (u.pathname === "/api/tags") return { ok: true, status: 200, json: async () => ({ models: [] }), text: async () => "" };
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  };
});
_after(() => { globalThis.fetch = _realFetch; });

function codeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "gtir-ctx-"));
  writeFileSync(join(repo, "lib.ts"),
    "export function helper(): number {\n" +
    "  // Returns a constant used by the runner below for the demo flow here.\n" +
    "  return 1;\n}\n");
  writeFileSync(join(repo, "main.ts"),
    "import { helper } from \"./lib\";\n" +
    "export function run(): number {\n" +
    "  // Calls the helper and returns its value to drive the example execution path.\n" +
    "  return helper();\n}\n");
  return repo;
}

test("buildContext query mode bundles source + callers/callees + quality", async () => {
  const repo = codeRepo();
  const cfg = { ...loadConfig(repo), ollamaUrl: "http://localhost:11434" };
  try {
    await buildIndex(cfg, { rebuild: true });
    await indexEdges(cfg, { rebuild: true, collect: false });
    const out = await buildContext(cfg, { query: "run the helper", k: 5 });
    assert.ok(["high", "medium", "low"].includes(out.retrieval_quality));
    assert.equal(typeof out.best_guesses, "boolean");
    assert.ok(out.items.length >= 1, "returned items");
    for (const it of out.items) {
      assert.equal(typeof it.source, "string");
      assert.ok(Array.isArray(it.callers) && Array.isArray(it.callees));
      assert.match(it.lines, /^\d+-\d+$/);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("buildContext errors when neither query nor targets given", async () => {
  const repo = codeRepo();
  const cfg = loadConfig(repo);
  try { assert.equal((await buildContext(cfg, {})).error, "query or targets required"); }
  finally { rmSync(repo, { recursive: true, force: true }); }
});
