import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { walkRepo, statPaths } from "./walker.mjs";
import { langFor } from "./languages.mjs";
import { grammarMissing, OPTIONAL_GRAMMARS, getParser } from "./parser.mjs";
import { chunkFile, stableId } from "./chunker.mjs";
import { contextualizeChunk } from "./contextualize.mjs";
import { embedTexts, contentHash } from "./embed.mjs";
import { openStore } from "./store.mjs";
import { extractCodeEdges, extractNotesEdges, resolveEdges } from "./edges.mjs";
import { declaredSymbols } from "./symbols.mjs";

// Columns the current row shape ALWAYS writes. content_hash is deliberately excluded — it's
// optional: a pre-cache table runs in legacy (no-reuse) mode rather than being force-rebuilt.
const REQUIRED_CHUNK_COLUMNS = ["id", "path", "language", "chunk_start", "chunk_end",
  "line_start", "line_end", "text", "fts_text", "mtime_ms", "embedding"];

// Build edges for the changed files and persist them. Re-reads + re-parses only the changed
// files (cheap on a refresh). symbolIndex/noteIndex are built from the FULL current chunk set so
// a call in a changed file can resolve to a definition in an unchanged file.
async function indexEdges(cfg, store, toIndex, { rebuild }) {
  if (rebuild) await store.dropEdges();
  if (!toIndex.length) return;

  const tbl = await store.chunksTable();
  const symbolIndex = new Map();
  const noteIndex = new Map();
  if (tbl) {
    const rows = await tbl.query().select(["path", "line_start", "line_end", "text", "language"]).toArray();
    for (const r of rows) {
      for (const name of declaredSymbols(r.text)) {
        if (!symbolIndex.has(name)) symbolIndex.set(name, []);
        symbolIndex.get(name).push({ path: r.path, line_start: Number(r.line_start), line_end: Number(r.line_end) });
      }
    }
    for (const r of rows) {
      if (r.language === "markdown") {
        const key = r.path.replace(/\\/g, "/").split("/").pop().replace(/\.(md|mdx)$/i, "").toLowerCase();
        if (!noteIndex.has(key)) noteIndex.set(key, []);
        if (!noteIndex.get(key).some((c) => c.path === r.path)) noteIndex.get(key).push({ path: r.path });
      }
    }
  }

  const all = [];
  for (const f of toIndex) {
    let text;
    try { text = readFileSync(f.absPath, "utf8"); } catch { continue; }
    const ext = extname(f.absPath);
    const langId = langFor(ext);
    let raw = [];
    if (langId === "markdown") {
      raw = extractNotesEdges(f.relPath, text);
    } else if (langId) {
      const parser = await getParser(langId).catch(() => null);
      if (parser) {
        let tree; try { tree = parser.parse(text); } catch { tree = null; }
        if (tree) raw = extractCodeEdges(tree, langId, f.relPath);
      }
    }
    if (raw.length) all.push(...resolveEdges(raw, symbolIndex, noteIndex));
  }
  const changed = [...new Set(toIndex.map((f) => f.relPath))];
  await store.evictEdgePaths(changed);
  if (all.length) await store.upsertEdges(all);
}

export async function buildIndex(cfg, { rebuild = false, paths = null } = {}) {
  const store = await openStore(cfg);
  const embed = cfg.embedImpl ?? ((texts) => embedTexts(texts, cfg));

  // Self-heal across schema upgrades: an index built by an older gtir may lack a column the
  // current row shape always writes (e.g. fts_text). Appending to it fails mid-refresh
  // ("Found field not in schema"), which would also break the post-commit hook on every
  // commit. Detect the drift up front and promote the whole run to a rebuild (drop+recreate).
  let schemaHealed = false;
  let tableExists = false;
  if (!rebuild) {
    const cols = await store.chunkColumns();
    tableExists = cols !== null;
    if (cols && REQUIRED_CHUNK_COLUMNS.some((c) => !cols.has(c))) { rebuild = true; schemaHealed = true; }
  }

  const manifest = rebuild ? {} : await store.loadManifest();

  // Targeted refresh: when the caller (the file-watcher) hands us the exact changed paths, stat
  // just those instead of walking the whole tree — O(changed), not O(files on disk). Empty/absent
  // paths or a rebuild fall back to the full walk: hooks, manual `refresh`, and the watcher's
  // startup catch-up (which must see everything that changed while it was off).
  const targeted = !rebuild && Array.isArray(paths) && paths.length > 0;
  const scan = targeted ? statPaths(cfg, paths) : { files: walkRepo(cfg), missing: null };
  const files = scan.files;
  const live = new Set(files.map((f) => f.relPath));

  // Detect optional (build-on-demand) grammars this repo needs but doesn't have installed —
  // e.g. the gitignored HLSL/GLSL wasm on a fresh clone. Those files are still indexed (via
  // line-windows); we just return a notice so the caller can point the user at the fix.
  // Lives in the index path (not init) so shaders added later are caught on the next run.
  const optionalCounts = new Map();
  for (const f of files) {
    const lang = langFor(extname(f.absPath));
    if (lang && OPTIONAL_GRAMMARS.has(lang)) optionalCounts.set(lang, (optionalCounts.get(lang) ?? 0) + 1);
  }
  const warnings = [];
  if (schemaHealed) warnings.push("index schema was out of date — rebuilt it (one-time, after a gtir upgrade).");
  for (const [lang, n] of optionalCounts) {
    if (grammarMissing(lang)) {
      warnings.push(`${n} ${lang.toUpperCase()} file${n > 1 ? "s" : ""} indexed as line-windows — `
        + `the ${lang} grammar isn't installed. Run \`gtir fetch-grammars\` for function-aligned chunking.`);
    }
  }

  const toIndex = [];
  let skipped = 0;
  for (const f of files) {
    if (!rebuild && manifest[f.relPath] === f.mtimeMs) { skipped++; continue; }
    toIndex.push(f);
  }
  const changedPaths = [...new Set(toIndex.map((f) => f.relPath))];

  // Evict deletions. Full walk: any manifest path no longer on disk. Targeted: only the batch's
  // vanished paths (the watcher reports unlinks; the startup full walk is the backstop for the rest).
  let evicted = 0;
  if (!rebuild) {
    const stale = targeted
      ? scan.missing.filter((p) => manifest[p] !== undefined)
      : Object.keys(manifest).filter((p) => !live.has(p));
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
    return { scanned: files.length, skipped, evicted, chunks: 0, dim: Number(meta.dim) || 0, reused: 0, embedded: 0, warnings };
  }

  // Contextualize, then embed — reusing cached embeddings for unchanged content.
  const ctx = [];
  for (const c of allChunks) ctx.push(await contextualizeChunk(c, cfg));
  const hashes = ctx.map((c) => contentHash(c.embedText));

  // Load the cache BEFORE any eviction/drop: reuse the prior index's embeddings when the
  // model matches and the existing table carries content_hash.
  const tableHasHash = await store.hasContentHash();
  const useCache = !cfg.noCache && tableHasHash && (await store.readMeta()).model === cfg.model;
  // Refresh: reuse only the changed files' prior vectors (O(changed)) — not the whole corpus.
  // Rebuild: load every vector (null) so unchanged content anywhere in the repo is reused.
  const cache = useCache ? await store.loadEmbedCache(rebuild ? null : changedPaths) : new Map();

  const missIdx = [];
  for (let i = 0; i < hashes.length; i++) if (!cache.has(hashes[i])) missIdx.push(i);
  const missVecs = missIdx.length ? await embed(missIdx.map((i) => ctx[i].embedText)) : [];
  if (missVecs.length !== missIdx.length) throw new Error(`embed returned ${missVecs.length} vectors for ${missIdx.length} chunks`);
  const vecs = new Array(ctx.length);
  for (let i = 0; i < ctx.length; i++) vecs[i] = cache.get(hashes[i]) ?? null;
  missIdx.forEach((i, k) => { vecs[i] = missVecs[k]; });
  const reused = ctx.length - missIdx.length;
  const embedded = missIdx.length;
  const dim = (vecs.find((v) => v) ?? []).length;

  // Replace prior rows. Rebuild drops+recreates the table (also migrates the schema to
  // include content_hash); refresh deletes the changed paths' rows (changedPaths computed above).
  if (rebuild) await store.dropChunks();
  else if (changedPaths.length) await store.evictPaths(changedPaths);

  // Write content_hash on a rebuild, when the table already carries it, OR when creating a FRESH
  // table — so a first `gtir index` (not just `init`/`--rebuild`) enables the embedding cache too.
  // Only a genuinely pre-cache table (created by an older gtir) stays in legacy no-hash mode rather
  // than being force-migrated. Without this, a non-rebuild first build re-embeds the whole changed
  // file on every refresh (the cache never engages).
  const writeHash = rebuild || tableHasHash || !tableExists;
  const rows = allChunks.map((c, i) => ({
    id: stableId(c), path: c.path, language: c.language,
    chunk_start: c.chunkStart, chunk_end: c.chunkEnd,
    line_start: c.lineStart, line_end: c.lineEnd,
    text: c.text, fts_text: ctx[i].ftsText,
    mtime_ms: c.mtimeMs, embedding: vecs[i],
    ...(writeHash ? { content_hash: hashes[i] } : {}),
  }));
  await store.upsertRows(rows);
  await store.writeMeta({ model: cfg.model, dim, version: cfg.version });

  try { await indexEdges(cfg, store, toIndex, { rebuild }); }
  catch (e) { warnings.push(`edge index skipped: ${e.message}`); }

  return { scanned: files.length, skipped, evicted, chunks: rows.length, dim, reused, embedded, warnings };
}
