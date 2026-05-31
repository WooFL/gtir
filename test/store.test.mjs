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
