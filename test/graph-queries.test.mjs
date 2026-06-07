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
