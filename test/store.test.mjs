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

test("dropChunks: removes the chunks table", async () => {
  const a = mkdtempSync(join(tmpdir(), "gtir-ch-"));
  const sa = await openStore({ indexDir: join(a, "i.lance") });
  await sa.upsertRows([rowH("a.md", "alpha", "h1")]);
  assert.notEqual(await sa.chunksTable(), null);
  await sa.dropChunks();
  assert.equal(await sa.chunksTable(), null);
});
