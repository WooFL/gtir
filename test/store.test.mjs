import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/store.mjs";

function row(path, text, mtime, vec = [0.1, 0.2, 0.3]) {
  return { id: `${path}:${text}`, path, language: "python",
    chunk_start: 0, chunk_end: text.length, line_start: 1, line_end: 1,
    text, mtime_ms: mtime, embedding: vec };
}

test("upsert then manifest reflects written paths and mtimes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-store-"));
  const store = await openStore({ indexDir: join(dir, "i.lance") });
  await store.upsertRows([row("a.py", "alpha body", 111), row("b.py", "beta body", 222)]);
  const man = await store.loadManifest();
  assert.equal(man["a.py"], 111);
  assert.equal(man["b.py"], 222);
});

test("evictPaths removes rows for deleted files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-store-"));
  const store = await openStore({ indexDir: join(dir, "i.lance") });
  await store.upsertRows([row("a.py", "alpha body", 111), row("b.py", "beta body", 222)]);
  await store.evictPaths(["b.py"]);
  const man = await store.loadManifest();
  assert.equal(man["a.py"], 111);
  assert.equal("b.py" in man, false);
});

test("writeMeta + readMeta roundtrip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-store-"));
  const store = await openStore({ indexDir: join(dir, "i.lance") });
  await store.upsertRows([row("a.py", "alpha body", 111)]);
  await store.writeMeta({ model: "jina-code-embeddings-0.5b", dim: 3, version: 1 });
  const meta = await store.readMeta();
  assert.equal(meta.model, "jina-code-embeddings-0.5b");
  assert.equal(meta.dim, "3");
});

test("upsertRows on an existing path replaces its rows (no doubling)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-store-"));
  const store = await openStore({ indexDir: join(dir, "i.lance") });
  await store.upsertRows([row("a.py", "first body", 100)]);
  // Re-index the same path with new content + mtime.
  await store.upsertRows([row("a.py", "second body REPLACED", 200)]);
  const man = await store.loadManifest();
  assert.equal(man["a.py"], 200);               // mtime updated, not stale 100
  const tbl = await store.chunksTable();
  const rows = await tbl.query().where("path = 'a.py'").toArray();
  assert.equal(rows.length, 1);                  // exactly one row, not doubled
  assert.match(rows[0].text, /REPLACED/);
});

function rowH(path, text, ch, vec = [0.1, 0.2, 0.3]) {
  return { id: `${path}:${text}`, path, language: "md", chunk_start: 0, chunk_end: text.length,
    line_start: 1, line_end: 1, text, mtime_ms: 1, embedding: vec, content_hash: ch };
}

test("hasContentHash: true when rows carry content_hash, false otherwise", async () => {
  const a = mkdtempSync(join(tmpdir(), "gtir-ch-"));
  const sa = await openStore({ indexDir: join(a, "i.lance") });
  assert.equal(await sa.hasContentHash(), false); // no table yet
  await sa.upsertRows([rowH("a.md", "alpha", "hash-a")]);
  assert.equal(await sa.hasContentHash(), true);
});

test("loadEmbedCache: returns {content_hash -> embedding}", async () => {
  const a = mkdtempSync(join(tmpdir(), "gtir-ch-"));
  const sa = await openStore({ indexDir: join(a, "i.lance") });
  await sa.upsertRows([rowH("a.md", "alpha", "h1", [1, 0, 0]), rowH("b.md", "beta", "h2", [0, 1, 0])]);
  const cache = await sa.loadEmbedCache();
  assert.equal(cache.size, 2);
  assert.deepEqual(Array.from(cache.get("h1")), [1, 0, 0]);
});

test("loadEmbedCache: scopes to given paths (refresh) vs loads all when omitted (rebuild)", async () => {
  const a = mkdtempSync(join(tmpdir(), "gtir-ch-"));
  const sa = await openStore({ indexDir: join(a, "i.lance") });
  await sa.upsertRows([rowH("a.md", "alpha", "h1", [1, 0, 0]), rowH("b.md", "beta", "h2", [0, 1, 0])]);
  assert.equal((await sa.loadEmbedCache()).size, 2, "no paths → whole table (rebuild reuse)");
  const scoped = await sa.loadEmbedCache(["a.md"]);
  assert.equal(scoped.size, 1, "scoped to a.md — b.md's vector never pulled");
  assert.deepEqual(Array.from(scoped.get("h1")), [1, 0, 0]);
  assert.equal(scoped.has("h2"), false);
  assert.equal((await sa.loadEmbedCache([])).size, 0, "empty change set → nothing to load");
});

test("dropChunks: removes the chunks table", async () => {
  const a = mkdtempSync(join(tmpdir(), "gtir-ch-"));
  const sa = await openStore({ indexDir: join(a, "i.lance") });
  await sa.upsertRows([rowH("a.md", "alpha", "h1")]);
  assert.notEqual(await sa.chunksTable(), null);
  await sa.dropChunks();
  assert.equal(await sa.chunksTable(), null);
});

// FTS rows must carry fts_text (production schema) so the index builds on the boosted column.
const rowF = (path, text, mtime) => ({
  id: `${path}:${text}`, path, language: "python",
  chunk_start: 0, chunk_end: text.length, line_start: 1, line_end: 1,
  text, fts_text: text, mtime_ms: mtime, embedding: [0.1, 0.2, 0.3],
});

test("upsertRows builds the FTS index once, then maintains it incrementally (optimize, no duplicate index)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-fts-"));
  const store = await openStore({ indexDir: join(dir, "i.lance") });

  await store.upsertRows([rowF("a.py", "alpha apple", 1), rowF("b.py", "beta banana", 2)]);
  // Re-open the table handle after each write — LanceDB handles are version-pinned, and upsertRows
  // mutates through its own handle (this mirrors search(), which opens a fresh handle per query).
  assert.equal((await (await store.chunksTable()).listIndices()).length, 1, "one FTS index after first build");

  // Incremental add: existing table -> optimize path, not a fresh createIndex.
  await store.upsertRows([rowF("c.py", "gamma cherry", 3)]);
  assert.equal((await (await store.chunksTable()).listIndices()).length, 1, "still exactly one index after incremental refresh");

  // Incrementally-added content is searchable.
  const hitC = await (await store.chunksTable()).query().nearestToText("cherry", ["fts_text"]).limit(5).toArray();
  assert.ok(hitC.some((r) => r.path === "c.py"), "new content searchable after incremental refresh");

  // Replacing a path drops its old term.
  await store.upsertRows([rowF("a.py", "alpha apricot", 4)]);
  const hitOld = await (await store.chunksTable()).query().nearestToText("apple", ["fts_text"]).limit(5).toArray();
  assert.ok(!hitOld.some((r) => r.path === "a.py"), "replaced content's old term no longer matches");
});

import { rmSync } from "node:fs";

test("allChunkRows returns selected columns; hasEdges reflects the edges table", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gtir-store-aq-"));
  const cfg = { indexDir: join(dir, ".gtir") };
  try {
    const store = await openStore(cfg);
    assert.equal(await store.hasEdges(), false);
    await store.upsertRows([
      { id: "1", path: "a.mjs", line_start: 1, line_end: 3, language: "js", text: "function f(){}", embedding: [0.1, 0.2], mtime_ms: 1, content_hash: "h1" },
    ]);
    const rows = await store.allChunkRows(["path", "text"]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, "a.mjs");
    assert.equal(rows[0].text, "function f(){}");
    await store.upsertEdges([{ kind: "calls", conf: "resolved", from_path: "a.mjs", from_lines: "1", from_symbol: "f", to_path: "a.mjs", to_lines: "1", to_symbol: "f", candidates: [], content_hash: "h1" }]);
    assert.equal(await store.hasEdges(), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
