import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { loadConfig } from "../src/config.mjs";
import { buildIndex } from "../src/indexer.mjs";
import { openStore } from "../src/store.mjs";

// Deterministic fake embedder: dim-3 vector seeded by text length.
function fakeEmbed(texts) {
  return Promise.resolve(texts.map((t) => {
    const n = t.length % 7 + 1;
    const v = [n, n + 1, n + 2];
    const len = Math.hypot(...v);
    return v.map((x) => x / len);
  }));
}

function repoWith(files) {
  const repo = mkdtempSync(join(tmpdir(), "gtir-idx-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(repo, name), body);
  return repo;
}

test("buildIndex indexes files and reports counts", async () => {
  const repo = repoWith({
    "user.py": [
      "class User:",
      "    def login(self, username, password):",
      "        # Authenticate the user and return a freshly minted session token on success.",
      "        if not username or not password:",
      "            return None",
      "        return create_session(username, password)",
    ].join("\n"),
    "note.md": [
      "# Authentication",
      "",
      "This document explains how the session manager creates and revokes tokens during",
      "the authentication flow, including the credential checks performed on each login.",
    ].join("\n"),
  });
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed, contextTier: "synthetic" };
  const res = await buildIndex(cfg, { rebuild: true });
  assert.ok(res.chunks >= 2);
  assert.equal(res.dim, 3);
});

test("incremental: unchanged files are skipped on second run", async () => {
  const repo = repoWith({
    "a.py": [
      "def alpha(items):",
      "    # Sum every value in the provided collection and return the running total here.",
      "    total = 0",
      "    for item in items:",
      "        total += item",
      "    return total",
    ].join("\n"),
  });
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed };
  await buildIndex(cfg, { rebuild: true });
  const second = await buildIndex(cfg, { rebuild: false });
  assert.equal(second.skipped >= 1, true);
});

test("no-op incremental refresh preserves meta dim (does not clobber to 0)", async () => {
  const repo = repoWith({
    "a.py": [
      "def alpha(items):",
      "    # Sum every value in the provided collection and return the running total here.",
      "    total = 0",
      "    for item in items:",
      "        total += item",
      "    return total",
    ].join("\n"),
  });
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed };
  await buildIndex(cfg, { rebuild: true });            // writes dim=3
  const store = await openStore(cfg);
  assert.equal((await store.readMeta()).dim, "3");      // sanity
  await buildIndex(cfg, { rebuild: false });            // no-op refresh, nothing changed
  assert.equal((await store.readMeta()).dim, "3");      // dim preserved, NOT clobbered to 0
});

// A counting embedder: records how many texts it was asked to embed.
function counter() {
  const state = { calls: 0 };
  const fn = (texts) => {
    state.calls += texts.length;
    return Promise.resolve(texts.map((t) => { const n = (t.length % 5) + 1; const v = [n, n + 1, n + 2]; const L = Math.hypot(...v); return v.map((x) => x / L); }));
  };
  return { fn, state };
}
const CODE = "export function foo(input) {\n  // a body long enough to comfortably clear the 100-char minimum chunk size threshold here\n  return String(input).trim();\n}";

test("rebuild reuses cached embeddings: second build embeds 0", async () => {
  const repo = repoWith({ "a.ts": CODE, "b.ts": CODE.replace("foo", "bar") });
  const c1 = counter();
  const r1 = await buildIndex({ ...loadConfig(repo), embedImpl: c1.fn }, { rebuild: true });
  assert.ok(r1.embedded >= 2 && c1.state.calls === r1.embedded);
  const c2 = counter();
  const r2 = await buildIndex({ ...loadConfig(repo), embedImpl: c2.fn }, { rebuild: true });
  assert.equal(c2.state.calls, 0, "unchanged rebuild should embed nothing");
  assert.equal(r2.reused, r2.chunks);
  assert.equal(r2.embedded, 0);
});

test("model change ignores the cache (re-embeds all)", async () => {
  const repo = repoWith({ "a.ts": CODE });
  await buildIndex({ ...loadConfig(repo), embedImpl: counter().fn }, { rebuild: true });
  const c2 = counter();
  await buildIndex({ ...loadConfig(repo), model: "different-model", embedImpl: c2.fn }, { rebuild: true });
  assert.ok(c2.state.calls > 0, "model change must re-embed");
});

test("--no-cache (cfg.noCache) forces re-embed", async () => {
  const repo = repoWith({ "a.ts": CODE });
  await buildIndex({ ...loadConfig(repo), embedImpl: counter().fn }, { rebuild: true });
  const c2 = counter();
  await buildIndex({ ...loadConfig(repo), noCache: true, embedImpl: c2.fn }, { rebuild: true });
  assert.ok(c2.state.calls > 0, "noCache must re-embed");
});

test("refresh reuses unchanged sections within a changed file", async () => {
  const md = "# Page\n\n## A\nSection A body that is stable and long enough to be its own chunk here.\n\n## B\nSection B body original and also long enough to be a real chunk on its own.\n";
  const repo = repoWith({ "p.md": md });
  await buildIndex({ ...loadConfig(repo), embedImpl: counter().fn }, { rebuild: true }); // initial
  writeFileSync(join(repo, "p.md"), md.replace("Section B body original", "Section B body EDITED"));
  const c2 = counter();
  const r = await buildIndex({ ...loadConfig(repo), embedImpl: c2.fn }, { rebuild: false });
  assert.ok(r.reused >= 1, "section A should be reused");
  assert.ok(r.embedded >= 1, "section B should be re-embedded");
  assert.equal(c2.state.calls, r.embedded);
});

test("legacy index: refresh on a forged content_hash-less table stays legacy, no schema error", async () => {
  const repo = repoWith({ "a.ts": CODE });
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed };
  // Forge a pre-cache table: rows WITHOUT content_hash (what an older gtir wrote). fts_text is
  // present so the schema self-heal doesn't fire — we want the genuine legacy path, not a heal.
  const db = await lancedb.connect(cfg.indexDir);
  await db.createTable("chunks", [{
    id: "x", path: "a.ts", language: "typescript",
    chunk_start: 0, chunk_end: 10, line_start: 1, line_end: 2,
    text: "old", fts_text: "old", mtime_ms: 1, embedding: [0, 0, 0],
  }]);
  assert.equal(await (await openStore(cfg)).hasContentHash(), false, "forged table is legacy");
  writeFileSync(join(repo, "a.ts"), CODE.replace("trim()", "trimEnd()"));
  const r = await buildIndex(cfg, { rebuild: false });
  assert.ok(r.chunks > 0, "refresh produced rows");
  assert.equal(await (await openStore(cfg)).hasContentHash(), false, "stays legacy — content_hash not force-added");
});

test("fresh index (plain `index`, not --rebuild) enables the embedding cache (writes content_hash)", async () => {
  const repo = repoWith({ "a.ts": CODE });
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed };
  await buildIndex(cfg, { rebuild: false });   // a first build that is NOT a rebuild
  assert.equal(await (await openStore(cfg)).hasContentHash(), true, "fresh build carries content_hash so refresh can reuse");
});

test("self-heal: refresh on a table missing fts_text rebuilds instead of erroring", async () => {
  const repo = repoWith({ "a.ts": CODE });
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed };
  // Forge a pre-FTS chunks table: rows WITHOUT the fts_text column current code always writes.
  const db = await lancedb.connect(cfg.indexDir);
  await db.createTable("chunks", [{
    id: "x", path: "a.ts", language: "typescript",
    chunk_start: 0, chunk_end: 10, line_start: 1, line_end: 2,
    text: "old", mtime_ms: 1, embedding: [0, 0, 0],
  }]);
  assert.ok(!(await openStore(cfg).then((s) => s.chunkColumns())).has("fts_text"), "forged table lacks fts_text");
  // A refresh must NOT throw a LanceDB schema mismatch — it self-heals by rebuilding.
  const r = await buildIndex(cfg, { rebuild: false });
  assert.ok(r.chunks > 0, "refresh produced rows");
  assert.ok((r.warnings || []).some((w) => /schema/i.test(w)), "surfaces a schema-heal notice");
  assert.ok((await openStore(cfg).then((s) => s.chunkColumns())).has("fts_text"), "rebuilt table has fts_text");
});

test("prefix-sensitivity: retitling a page changes the hash and forces re-embed", async () => {
  const body = "## Stable Section\nThis section body stays exactly the same across the retitle and is long enough to be its own chunk for sure.\n";
  const repo = repoWith({ "p.md": "# Original Title\n\n" + body });
  await buildIndex({ ...loadConfig(repo), embedImpl: counter().fn }, { rebuild: true });
  // Retitle the H1 — the section's body is byte-identical, but its heading breadcrumb prefix changes.
  writeFileSync(join(repo, "p.md"), "# Renamed Title\n\n" + body);
  const c2 = counter();
  const r = await buildIndex({ ...loadConfig(repo), embedImpl: c2.fn }, { rebuild: false });
  assert.ok(c2.state.calls > 0, "retitle must re-embed (prefix changed → new hash)");
  assert.ok(r.embedded >= 1, "at least the retitled section re-embeds");
});

test("targeted refresh: only the named paths are reconsidered (a file changed off-list is left alone)", async () => {
  const repo = repoWith({ "a.ts": CODE, "b.ts": CODE.replace("foo", "bar") });
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed };
  await buildIndex(cfg, { rebuild: true });
  // change BOTH on disk, but hand buildIndex only a.ts
  writeFileSync(join(repo, "a.ts"), CODE.replace("trim()", "trimEnd()"));
  writeFileSync(join(repo, "b.ts"), CODE.replace("foo", "bar").replace("trim()", "trimEnd()"));
  const r = await buildIndex(cfg, { rebuild: false, paths: ["a.ts"] });
  assert.equal(r.scanned, 1, "only a.ts statted — the repo was not walked");
  const store = await openStore(cfg);
  assert.ok((await store.chunksByPath("a.ts")).some((x) => /trimEnd/.test(x.text)), "a.ts reindexed");
  const bText = (await store.chunksByPath("b.ts")).map((x) => x.text).join("\n");
  assert.ok(/trim\(\)/.test(bText) && !/trimEnd/.test(bText), "b.ts left at its old indexed content");
});

test("targeted refresh: a path gone from disk is evicted; others untouched", async () => {
  const repo = repoWith({ "a.ts": CODE, "b.ts": CODE.replace("foo", "bar") });
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed };
  await buildIndex(cfg, { rebuild: true });
  rmSync(join(repo, "b.ts"));
  const r = await buildIndex(cfg, { rebuild: false, paths: ["b.ts"] });
  assert.equal(r.evicted, 1);
  const man = await (await openStore(cfg)).loadManifest();
  assert.equal(man["b.ts"], undefined, "b.ts evicted");
  assert.notEqual(man["a.ts"], undefined, "a.ts untouched");
});

test("empty paths falls back to a full walk (the watcher startup catch-up)", async () => {
  const repo = repoWith({ "a.ts": CODE });
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed };
  await buildIndex(cfg, { rebuild: true });
  writeFileSync(join(repo, "a.ts"), CODE.replace("trim()", "trimEnd()"));
  const r = await buildIndex(cfg, { rebuild: false, paths: [] });   // empty → full walk, not a no-op
  assert.ok(r.chunks > 0);
  assert.ok((await (await openStore(cfg)).chunksByPath("a.ts")).some((x) => /trimEnd/.test(x.text)), "full walk picked up the change");
});

test("buildIndex populates the edges table for code", async () => {
  // Functions must be long enough to clear the minimum chunk size threshold (~100 chars body).
  const tokenSrc = [
    "export function verifyToken(x) {",
    "  // Verify the supplied token value and delegate to the internal decode helper below.",
    "  return decode(x);",
    "}",
    "function decode(x) {",
    "  // Internal decode: strips the outer wrapper and returns the raw payload value here.",
    "  return x;",
    "}",
  ].join("\n") + "\n";
  const mwSrc = [
    'import { verifyToken } from "./token";',
    "export function mw(r) {",
    "  // Middleware: authenticate each incoming request by delegating to verifyToken below.",
    "  return verifyToken(r);",
    "}",
  ].join("\n") + "\n";
  const repo = repoWith({ "token.ts": tokenSrc, "mw.ts": mwSrc });
  const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed };
  await buildIndex(cfg, { rebuild: true });
  const store = await openStore(cfg);
  const edges = await store.loadEdges();
  const call = edges.find((e) => e.kind === "calls" && e.to_symbol === "verifyToken");
  assert.ok(call, "expected a resolved call edge to verifyToken");
  assert.equal(call.from_path, "mw.ts");
  assert.equal(call.conf, "resolved");
});

test("indexer: ambiguous call promoted to inferred toward the embedding-closest def", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-disambig-"));
  writeFileSync(join(repo, "near.js"), "function target(){ /* MARKER */ return 1; }\n");
  writeFileSync(join(repo, "far.js"), "function target(){ return 2; }\n");
  writeFileSync(join(repo, "caller.js"), "import \"./near\";\nfunction use(){ /* MARKER */ return target(); }\n");
  // Embedder: chunks containing MARKER → [1,0,0]; others → [0,1,0]. So caller≈near, far orthogonal.
  const markerEmbed = (texts) => Promise.resolve(texts.map((t) => (/MARKER/.test(t) ? [1, 0, 0] : [0, 1, 0])));
  try {
    await buildIndex({ ...loadConfig(repo), embedImpl: markerEmbed, minChars: 1 }, { rebuild: true });
    const store = await openStore(loadConfig(repo));
    const edges = await store.loadEdges();
    const call = edges.find((e) => e.kind === "calls" && e.ref_name === "target");
    assert.ok(call, "expected a calls edge for target");
    assert.equal(call.conf, "inferred");
    assert.equal(call.to_path, "near.js");
    assert.ok(call.score > 0.5);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("indexer: a cross-file ambiguous call is NOT promoted when the call site imports neither candidate", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-noimport-"));
  writeFileSync(join(repo, "near.js"), "function target(){ /* MARKER */ return 1; }\n");
  writeFileSync(join(repo, "far.js"), "function target(){ return 2; }\n");
  // caller imports NEITHER candidate -> neither is import-reachable -> stays ambiguous.
  writeFileSync(join(repo, "caller.js"), "function use(){ /* MARKER */ return target(); }\n");
  const markerEmbed = (texts) => Promise.resolve(texts.map((t) => (/MARKER/.test(t) ? [1, 0, 0] : [0, 1, 0])));
  try {
    await buildIndex({ ...loadConfig(repo), embedImpl: markerEmbed, minChars: 1 }, { rebuild: true });
    const edges = await openStore(loadConfig(repo)).then((s) => s.loadEdges());
    const call = edges.find((e) => e.kind === "calls" && e.ref_name === "target");
    assert.ok(call, "expected a calls edge for target");
    assert.equal(call.conf, "ambiguous"); // no import-reachable candidate -> not promoted
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("indexer: pre-score edges table triggers a one-time rebuild (edge-schema heal)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-edgeheal-"));
  // a() calls b() (same file, unique) → a resolved call edge, so the rebuilt edges table is
  // non-empty and therefore carries the `score` column after the heal.
  writeFileSync(join(repo, "a.js"), "function a(){ return b(); }\nfunction b(){ return 1; }\n");
  try {
    const cfg = { ...loadConfig(repo), embedImpl: fakeEmbed, minChars: 1 };
    await buildIndex(cfg, { rebuild: true });
    // Simulate a legacy edges table with no `score` column by recreating it without one.
    const db = await lancedb.connect(loadConfig(repo).indexDir);
    if ((await db.tableNames()).includes("edges")) await db.dropTable("edges");
    await db.createTable("edges", [{ kind: "calls", conf: "resolved", from_path: "a.js", from_lines: "1",
      from_symbol: "a", to_path: "a.js", to_lines: "1", to_symbol: "a", ref_name: "a",
      candidates_json: "[]", content_hash: "h" }]); // NOTE: no `score` field
    const store0 = await openStore(loadConfig(repo));
    assert.equal((await store0.edgeColumns()).has("score"), false);
    const r = await buildIndex({ ...loadConfig(repo), embedImpl: fakeEmbed, minChars: 1 }, {});
    const store = await openStore(loadConfig(repo));
    assert.ok((await store.edgeColumns()).has("score"), "edges table should carry score after heal");
    assert.ok((r.warnings || []).some((w) => /schema/i.test(w)), "expected a schema-heal warning");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("refresh: deleting a definition file re-resolves its callers (no stale resolved edge)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-del-"));
  writeFileSync(join(repo, "a.ts"), `import { helper } from "./b";\nexport function caller(){ return helper(); }\n`);
  writeFileSync(join(repo, "b.ts"), `export function helper(){ return 1; }\n`);
  try {
    await buildIndex({ ...loadConfig(repo), embedImpl: fakeEmbed, minChars: 1 }, { rebuild: true });
    let call = (await openStore(loadConfig(repo)).then((s) => s.loadEdges())).find((e) => e.kind === "calls" && e.ref_name === "helper");
    assert.equal(call.conf, "resolved"); assert.equal(call.to_path, "b.ts");
    await new Promise((r) => setTimeout(r, 1100));
    rmSync(join(repo, "b.ts"));
    await buildIndex({ ...loadConfig(repo), embedImpl: fakeEmbed, minChars: 1 }, { rebuild: false });
    call = (await openStore(loadConfig(repo)).then((s) => s.loadEdges())).find((e) => e.kind === "calls" && e.ref_name === "helper");
    assert.equal(call.conf, "external"); assert.equal(call.to_path, null);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("refresh: adding a definition rebinds a previously-external UNCHANGED caller", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-add-"));
  writeFileSync(join(repo, "a.ts"), `import { helper } from "./b";\nexport function caller(){ return helper(); }\n`);
  try {
    await buildIndex({ ...loadConfig(repo), embedImpl: fakeEmbed, minChars: 1 }, { rebuild: true });
    let call = (await openStore(loadConfig(repo)).then((s) => s.loadEdges())).find((e) => e.kind === "calls" && e.ref_name === "helper");
    assert.equal(call.conf, "external");
    await new Promise((r) => setTimeout(r, 1100));
    writeFileSync(join(repo, "b.ts"), `export function helper(){ return 1; }\n`); // a.ts UNCHANGED; only b.ts added
    await buildIndex({ ...loadConfig(repo), embedImpl: fakeEmbed, minChars: 1 }, { rebuild: false });
    call = (await openStore(loadConfig(repo)).then((s) => s.loadEdges())).find((e) => e.kind === "calls" && e.ref_name === "helper");
    assert.equal(call.conf, "resolved"); assert.equal(call.to_path, "b.ts");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("refresh: modifying a definition's body leaves caller edges correct", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-mod-"));
  writeFileSync(join(repo, "a.ts"), `import { helper } from "./b";\nexport function caller(){ return helper(); }\n`);
  writeFileSync(join(repo, "b.ts"), `export function helper(){ return 1; }\n`);
  try {
    await buildIndex({ ...loadConfig(repo), embedImpl: fakeEmbed, minChars: 1 }, { rebuild: true });
    await new Promise((r) => setTimeout(r, 1100));
    writeFileSync(join(repo, "b.ts"), `export function helper(){ return 42; }\nfunction extra(){ return 0; }\n`);
    await buildIndex({ ...loadConfig(repo), embedImpl: fakeEmbed, minChars: 1 }, { rebuild: false });
    const call = (await openStore(loadConfig(repo)).then((s) => s.loadEdges())).find((e) => e.kind === "calls" && e.ref_name === "helper");
    assert.equal(call.conf, "resolved"); assert.equal(call.to_path, "b.ts");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("refresh: deleting an isolated file with no callers is a clean no-op", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-delonly-"));
  writeFileSync(join(repo, "a.ts"), `export function alone(){ return 1; }\n`);
  writeFileSync(join(repo, "b.ts"), `export function other(){ return 2; }\n`);
  try {
    await buildIndex({ ...loadConfig(repo), embedImpl: fakeEmbed, minChars: 1 }, { rebuild: true });
    await new Promise((r) => setTimeout(r, 1100));
    rmSync(join(repo, "a.ts"));
    const r = await buildIndex({ ...loadConfig(repo), embedImpl: fakeEmbed, minChars: 1 }, { rebuild: false });
    assert.ok(r);
    const edges = await openStore(loadConfig(repo)).then((s) => s.loadEdges());
    assert.ok(!edges.some((e) => e.from_path === "a.ts"));
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("indexEdges resolves a Go method call by receiver type (cross-file)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "gtir-go-"));
  writeFileSync(join(repo, "batcher.go"), `package p\ntype Batcher struct{}\nfunc (b *Batcher) Flush() {}\n`);
  writeFileSync(join(repo, "logger.go"), `package p\ntype Logger struct{}\nfunc (l *Logger) Flush() {}\n`);
  writeFileSync(join(repo, "use.go"), `package p\nfunc run(b *Batcher) { b.Flush() }\n`);
  const cfg = loadConfig(repo);
  cfg.embedImpl = (texts) => Promise.resolve(texts.map(() => [1, 0, 0]));
  cfg.minChars = 1;
  await buildIndex(cfg, { rebuild: true });
  const edges = await (await openStore(cfg)).loadEdges();
  const flush = edges.find((e) => e.kind === "calls" && e.from_path === "use.go" && e.ref_name === "Flush");
  assert.ok(flush, "expected a Flush call edge from use.go");
  assert.equal(flush.conf, "resolved");        // type-pinned, not ambiguous
  assert.equal(flush.to_path, "batcher.go");     // resolved to Batcher, not Logger
});
