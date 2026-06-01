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
    // Maintain the BM25 FTS index incrementally. Build it once (full) when the table has no index
    // yet — the first build, or a fresh table after --rebuild's dropChunks(). On every later refresh,
    // fold the new fragments in and prune deletes via optimize() — O(changed), not O(corpus) per
    // write. gtir creates only the FTS index, so a non-empty index list means it already exists.
    // Prefer the boosted `fts_text` column (path/scope/decl weighted ahead of the body); fall back
    // to raw `text` for pre-existing schemas.
    try {
      const hasIndex = (await tbl.listIndices()).length > 0;
      if (hasIndex) {
        await tbl.optimize();
      } else {
        try { await tbl.createIndex("fts_text", { config: lancedb.Index.fts(), replace: true }); }
        catch { await tbl.createIndex("text", { config: lancedb.Index.fts(), replace: true }); }
      }
    } catch { /* older builds / empty table: degrade to vector-only at search time */ }
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

  async function hasContentHash() {
    const tbl = await chunksTable();
    if (!tbl) return false;
    try {
      const rows = await tbl.query().limit(1).toArray();
      return rows.length > 0 && Object.prototype.hasOwnProperty.call(rows[0], "content_hash");
    } catch { return false; }
  }

  // Column names of the existing chunks table (null if there's no table). Used to detect
  // schema drift across gtir upgrades. Reads the Arrow schema directly (works on empty
  // tables); falls back to sampling a row if schema() is unavailable in this lancedb build.
  async function chunkColumns() {
    const tbl = await chunksTable();
    if (!tbl) return null;
    try {
      const schema = await tbl.schema();
      return new Set(schema.fields.map((f) => f.name));
    } catch {
      try {
        const rows = await tbl.query().limit(1).toArray();
        return rows.length ? new Set(Object.keys(rows[0])) : null;
      } catch { return null; }
    }
  }

  async function loadEmbedCache() {
    const tbl = await chunksTable();
    if (!tbl) return new Map();
    let rows;
    try { rows = await tbl.query().select(["content_hash", "embedding"]).toArray(); }
    catch { return new Map(); } // table lacks the column
    const m = new Map();
    for (const r of rows) {
      if (r.content_hash && r.embedding) m.set(r.content_hash, Array.from(r.embedding));
    }
    return m;
  }

  async function dropChunks() {
    const names = await tableNames();
    if (names.includes("chunks")) await db.dropTable("chunks");
  }

  // All chunks for one file, ordered by start line — the source for `outline`.
  async function chunksByPath(path) {
    const tbl = await chunksTable();
    if (!tbl) return [];
    const rows = await tbl.query().where(`path = ${quote(path)}`)
      .select(["id", "line_start", "line_end", "language", "text"]).toArray();
    return rows.sort((a, b) => Number(a.line_start) - Number(b.line_start));
  }

  // The chunk covering `line` in `path` (or the file's first chunk if line is null) —
  // returns the full row including its embedding, the seed for `similar`.
  async function chunkAt(path, line = null) {
    const tbl = await chunksTable();
    if (!tbl) return null;
    const rows = (await tbl.query().where(`path = ${quote(path)}`).toArray())
      .sort((a, b) => Number(a.line_start) - Number(b.line_start));
    if (rows.length === 0) return null;
    if (line == null) return rows[0];
    return rows.find((r) => Number(r.line_start) <= line && line <= Number(r.line_end)) || rows[0];
  }

  return { chunksTable, upsertRows, loadManifest, evictPaths, writeMeta, readMeta, hasContentHash, chunkColumns, loadEmbedCache, dropChunks, chunksByPath, chunkAt };
}
