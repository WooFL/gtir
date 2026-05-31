import { mkdirSync } from "node:fs";
import * as lancedb from "@lancedb/lancedb";

function quote(s) { return `'${String(s).replace(/'/g, "''")}'`; }
function inList(paths) { return paths.map(quote).join(", "); }

export async function openStore(cfg) {
  mkdirSync(cfg.indexDir, { recursive: true });
  const db = await lancedb.connect(cfg.indexDir);

  async function tableNames() { return await db.tableNames(); }

  async function chunksTable() {
    const names = await tableNames();
    return names.includes("chunks") ? await db.openTable("chunks") : null;
  }

  async function upsertRows(rows) {
    if (rows.length === 0) return;
    const paths = [...new Set(rows.map((r) => r.path))];
    let tbl = await chunksTable();
    if (!tbl) {
      tbl = await db.createTable("chunks", rows); // schema inferred from data
    } else {
      await tbl.delete(`path IN (${inList(paths)})`); // delete-then-add upsert
      await tbl.add(rows);
    }
    // (Re)build BM25 FTS over the text column. Mirrors flow.py create_fts_index.
    try { await tbl.createIndex("text", { config: lancedb.Index.fts(), replace: true }); }
    catch { /* older builds / empty table: degrade to vector-only at search time */ }
  }

  async function loadManifest() {
    const tbl = await chunksTable();
    if (!tbl) return {};
    const rows = await tbl.query().select(["path", "mtime_ms"]).toArray();
    const out = {};
    for (const r of rows) {
      const m = Number(r.mtime_ms);
      if (!Number.isFinite(m)) continue;
      if (out[r.path] === undefined || out[r.path] < m) out[r.path] = m;
    }
    return out;
  }

  async function evictPaths(paths) {
    if (paths.length === 0) return;
    const tbl = await chunksTable();
    if (tbl) await tbl.delete(`path IN (${inList(paths)})`);
  }

  async function writeMeta({ model, dim, version }) {
    const names = await tableNames();
    const rows = [
      { key: "model", value: String(model) },
      { key: "dim", value: String(dim) },
      { key: "version", value: String(version) },
      { key: "built_at", value: String(Math.floor(Date.now() / 1000)) },
    ];
    if (names.includes("meta")) {
      const t = await db.openTable("meta");
      await t.delete("true");
      await t.add(rows);
    } else {
      await db.createTable("meta", rows);
    }
  }

  async function readMeta() {
    const names = await tableNames();
    if (!names.includes("meta")) return {};
    const t = await db.openTable("meta");
    const rows = await t.query().toArray();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  return { db, chunksTable, upsertRows, loadManifest, evictPaths, writeMeta, readMeta };
}
