import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { walkRepo } from "./walker.mjs";
import { chunkFile, stableId } from "./chunker.mjs";
import { contextualizeChunk } from "./contextualize.mjs";
import { embedTexts } from "./embed.mjs";
import { openStore } from "./store.mjs";

export async function buildIndex(cfg, { rebuild = false } = {}) {
  const store = await openStore(cfg);
  const embed = cfg.embedImpl ?? ((texts) => embedTexts(texts, cfg));

  const manifest = rebuild ? {} : await store.loadManifest();
  const files = walkRepo(cfg);
  const live = new Set(files.map((f) => f.relPath));

  const toIndex = [];
  let skipped = 0;
  for (const f of files) {
    if (!rebuild && manifest[f.relPath] === f.mtimeMs) { skipped++; continue; }
    toIndex.push(f);
  }

  // Evict rows for deleted/moved files (manifest paths no longer on disk).
  let evicted = 0;
  if (!rebuild) {
    const stale = Object.keys(manifest).filter((p) => !live.has(p));
    if (stale.length) { await store.evictPaths(stale); evicted = stale.length; }
  }

  // Chunk (CPU-bound).
  const allChunks = [];
  for (const f of toIndex) {
    let text;
    try { text = readFileSync(f.absPath, "utf8"); } catch { continue; }
    const chunks = await chunkFile(f.relPath, extname(f.absPath), text, cfg);
    for (const c of chunks) { c.mtimeMs = f.mtimeMs; allChunks.push(c); }
  }

  if (allChunks.length === 0) {
    // Nothing to (re)embed. Do NOT clobber existing meta — a no-op refresh after
    // a git commit is common and must preserve the dim recorded by the last real
    // build. Report the existing dim if the index already exists.
    const meta = await store.readMeta();
    return { scanned: files.length, skipped, evicted, chunks: 0, dim: Number(meta.dim) || 0 };
  }

  // Contextualize, then embed.
  const ctx = [];
  for (const c of allChunks) ctx.push(await contextualizeChunk(c, cfg));
  const vecs = await embed(ctx.map((c) => c.embedText));
  const dim = vecs[0]?.length ?? 0;

  // Upsert (delete-by-path happens inside store for changed paths).
  const changedPaths = [...new Set(toIndex.map((f) => f.relPath))];
  if (changedPaths.length) await store.evictPaths(changedPaths);
  const rows = allChunks.map((c, i) => ({
    id: stableId(c), path: c.path, language: c.language,
    chunk_start: c.chunkStart, chunk_end: c.chunkEnd,
    line_start: c.lineStart, line_end: c.lineEnd,
    text: c.text, mtime_ms: c.mtimeMs, embedding: vecs[i],
  }));
  await store.upsertRows(rows);
  await store.writeMeta({ model: cfg.model, dim, version: cfg.version });

  return { scanned: files.length, skipped, evicted, chunks: rows.length, dim };
}
