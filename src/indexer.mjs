import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { resolveAutoModel } from "./config.mjs";
import { walkRepo, statPaths } from "./walker.mjs";
import { langFor } from "./languages.mjs";
import { grammarMissing, OPTIONAL_GRAMMARS, getParser } from "./parser.mjs";
import { chunkFile, stableId } from "./chunker.mjs";
import { contextualizeChunk } from "./contextualize.mjs";
import { embedTexts, contentHash } from "./embed.mjs";
import { openStore } from "./store.mjs";
import { extractCodeEdges, extractNotesEdges, resolveEdges, noteKey } from "./edges.mjs";
import { disambiguateEdges } from "./disambiguate.mjs";
import { declaredSymbols, declaredCallables } from "./symbols.mjs";
import { extractGoMethodDefs, resolveGoMethods, extractGoInterfaces, resolveGoDispatch } from "./go-types.mjs";
import { extractCppMethodDefs, resolveCppMethods, extractCppReturnTypes, extractCppBases, extractCppVirtuals, extractCppOverrides, resolveCppDispatch, extractCppFields, resolveCppFieldReceivers } from "./cpp-types.mjs";
import { extractTsClassNames, resolveTsMethods } from "./ts-types.mjs";

// Columns the current row shape ALWAYS writes. content_hash is deliberately excluded — it's
// optional: a pre-cache table runs in legacy (no-reuse) mode rather than being force-rebuilt.
const REQUIRED_CHUNK_COLUMNS = ["id", "path", "language", "chunk_start", "chunk_end",
  "line_start", "line_end", "text", "fts_text", "mtime_ms", "embedding"];

// The innermost enclosing-scope name from a chunk's persisted scope_json breadcrumb, or null. Used to
// recover the class of an in-class C++ method whose chunk lost its `class X {` header to a chunk split.
function chunkScopeClass(scopeJson) {
  if (!scopeJson) return null;
  try { const sc = JSON.parse(scopeJson); return Array.isArray(sc) && sc.length ? sc[sc.length - 1] : null; }
  catch { return null; }
}

// Build edges for the changed files and persist them. Re-reads + re-parses only the changed
// files (cheap on a refresh). symbolIndex/noteIndex are built from the FULL current chunk set so
// a call in a changed file can resolve to a definition in an unchanged file.
async function indexEdges(cfg, store, toIndex, { rebuild, deleted = [] }) {
  if (rebuild) await store.dropEdges();
  const tbl = await store.chunksTable();
  if (!tbl) return;

  const changedSet = new Set(toIndex.map((f) => f.relPath));
  const deletedSet = new Set(deleted);
  // Custom smart-pointer wrappers (cfg.cppSmartPointers) override extractCppFields' DEFAULT_SMART_PTRS;
  // undefined lets the extractor use its std unique/shared/weak_ptr default.
  const cppSmartPtrs = cfg.cppSmartPointers ? new Set(cfg.cppSmartPointers) : undefined;
  const symbolIndex = new Map(), noteIndex = new Map(), callSiteVec = new Map(), chunkByPath = new Map();
  const goMethodIndex = new Map();
  const goInterfaceIndex = new Map();
  const cppMethodIndex = new Map();
  const cppReturnIndex = new Map();
  const cppBaseIndex = new Map();  // class -> Set(direct bases)
  const cppFieldIndex = new Map(); // class -> Map(field -> {type, smartPtr})
  const cppVirtualMethods = new Map();
  const cppOverrideMethods = new Map();
  const tsClassFiles = new Map();
  const tsCallableFiles = new Map();
  // Symbols declared by the changed files (drives the "a new def appeared" caller re-resolution).
  // Relies on buildIndex having already upsertRows'd the changed files BEFORE calling indexEdges —
  // so the chunks table here reflects the new state. Keep that ordering.
  const changedSymbols = new Set();
  // scope_json (the chunker's enclosing-scope breadcrumb) is optional — present only on tables built
  // since #8. Select it when the column exists so the C++ method index can recover a split method's
  // class; a pre-scope table degrades to header-in-text-only keying (the prior behavior).
  const hasScope = (await store.chunkColumns())?.has("scope_json") === true;
  const selectCols = ["path", "line_start", "line_end", "text", "language", "embedding", "content_hash"];
  const rows = await tbl.query().select(hasScope ? [...selectCols, "scope_json"] : selectCols).toArray();
  for (const r of rows) {
    if (r.content_hash && r.embedding) callSiteVec.set(r.content_hash, Array.from(r.embedding));
    if (r.content_hash) {
      if (!chunkByPath.has(r.path)) chunkByPath.set(r.path, []);
      chunkByPath.get(r.path).push({ line_start: Number(r.line_start), line_end: Number(r.line_end), content_hash: r.content_hash });
    }
    for (const name of declaredSymbols(r.text)) {
      if (!symbolIndex.has(name)) symbolIndex.set(name, []);
      symbolIndex.get(name).push({ path: r.path, line_start: Number(r.line_start), line_end: Number(r.line_end),
        embedding: r.embedding ? Array.from(r.embedding) : null, content_hash: r.content_hash || null });
      if (changedSet.has(r.path)) changedSymbols.add(name);
    }
    if (r.language === "go") {
      const seenMethods = new Set();
      for (const { type, method } of extractGoMethodDefs(r.text)) {
        const k = `${type}#${method}`;
        if (!goMethodIndex.has(k)) goMethodIndex.set(k, []);
        goMethodIndex.get(k).push({ path: r.path, line_start: Number(r.line_start), line_end: Number(r.line_end) });
        // Also register Go method names in symbolIndex so resolveEdges can produce "ambiguous"
        // edges (Go methods with receivers are not matched by the keyword regex in declaredSymbols).
        // Dedup per chunk: one symbolIndex entry per method name even if the chunk holds two
        // same-named methods on different types.
        if (seenMethods.has(method)) continue;
        seenMethods.add(method);
        if (!symbolIndex.has(method)) symbolIndex.set(method, []);
        symbolIndex.get(method).push({ path: r.path, line_start: Number(r.line_start), line_end: Number(r.line_end),
          embedding: r.embedding ? Array.from(r.embedding) : null, content_hash: r.content_hash || null });
        if (changedSet.has(r.path)) changedSymbols.add(method);
      }
      for (const { name, methods } of extractGoInterfaces(r.text)) goInterfaceIndex.set(name, new Set(methods));
    }
    if (r.language === "cpp") {
      const scopeClass = hasScope ? chunkScopeClass(r.scope_json) : null;
      for (const { cls, method } of extractCppMethodDefs(r.text, scopeClass)) {
        const k = `${cls}#${method}`;
        if (!cppMethodIndex.has(k)) cppMethodIndex.set(k, []);
        cppMethodIndex.get(k).push({ path: r.path, line_start: Number(r.line_start), line_end: Number(r.line_end) });
      }
      for (const { name, returnType } of extractCppReturnTypes(r.text)) {
        if (!cppReturnIndex.has(name)) cppReturnIndex.set(name, new Set());
        cppReturnIndex.get(name).add(returnType);
      }
      for (const { cls, bases } of extractCppBases(r.text)) {
        if (!cppBaseIndex.has(cls)) cppBaseIndex.set(cls, new Set());
        for (const b of bases) cppBaseIndex.get(cls).add(b);
      }
      for (const { cls, method } of extractCppVirtuals(r.text, scopeClass)) {
        if (!cppVirtualMethods.has(cls)) cppVirtualMethods.set(cls, new Set());
        cppVirtualMethods.get(cls).add(method);
      }
      for (const { cls, method } of extractCppOverrides(r.text, scopeClass)) {
        if (!cppOverrideMethods.has(cls)) cppOverrideMethods.set(cls, new Set());
        cppOverrideMethods.get(cls).add(method);
      }
      for (const { cls, field, type, smartPtr } of extractCppFields(r.text, scopeClass, cppSmartPtrs)) {
        if (!cppFieldIndex.has(cls)) cppFieldIndex.set(cls, new Map());
        const fields = cppFieldIndex.get(cls);
        if (!fields.has(field)) fields.set(field, { type, smartPtr });   // first-write-wins per (cls, field)
      }
    }
    if (r.language === "typescript" || r.language === "tsx" || r.language === "javascript") {
      for (const cls of extractTsClassNames(r.text)) {
        if (!tsClassFiles.has(cls)) tsClassFiles.set(cls, new Set());
        tsClassFiles.get(cls).add(r.path);
      }
      for (const name of declaredCallables(r.text)) {
        if (!tsCallableFiles.has(name)) tsCallableFiles.set(name, []);
        tsCallableFiles.get(name).push({ path: r.path, line_start: Number(r.line_start), line_end: Number(r.line_end) });
      }
    }
  }
  for (const r of rows) {
    if (r.language === "markdown") {
      const key = r.path.replace(/\\/g, "/").split("/").pop().replace(/\.(md|mdx)$/i, "").toLowerCase();
      if (!noteIndex.has(key)) noteIndex.set(key, []);
      if (!noteIndex.get(key).some((c) => c.path === r.path)) noteIndex.get(key).push({ path: r.path });
    }
  }

  // Re-extract set: changed files + unchanged callers whose call resolution could have changed.
  // Note keys (basename, lowercased) of changed markdown files — lets an unresolved/resolved
  // [[C]] link re-resolve when a note named C is added/changed/renamed-in (mirrors nameNowDeclared).
  const changedNoteNames = new Set();
  for (const p of changedSet) if (/\.(md|mdx)$/i.test(p)) changedNoteNames.add(noteKey(p));
  const reExtract = new Set(changedSet);
  if (!rebuild) {
    const existing = await store.loadEdges();
    for (const e of existing) {
      if (!e.from_path) continue;
      if (changedSet.has(e.from_path) || deletedSet.has(e.from_path)) continue; // changed (in set) / deleted (evicted)
      const targetChanged = e.to_path && (changedSet.has(e.to_path) || deletedSet.has(e.to_path));
      const candChanged = (e.candidates || []).some((c) => changedSet.has(c) || deletedSet.has(c));
      let nameTrigger = false;
      if (e.kind === "calls") nameTrigger = e.ref_name && changedSymbols.has(e.ref_name);
      else if (e.kind === "links" || e.kind === "embeds") nameTrigger = e.ref_name && changedNoteNames.has(noteKey(e.ref_name));
      else continue;   // imports: not re-resolved here (unchanged behavior)
      if (targetChanged || candChanged || nameTrigger) reExtract.add(e.from_path);
    }
  }
  for (const d of deletedSet) reExtract.delete(d);
  if (reExtract.size === 0 && deletedSet.size === 0) return;

  const byRel = new Map(toIndex.map((f) => [f.relPath, f]));
  const targets = [...reExtract].map((rel) => byRel.get(rel) ?? { relPath: rel, absPath: join(cfg.repo, rel) });

  let all = [];
  for (const f of targets) {
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
        if (tree) raw = extractCodeEdges(tree, langId, f.relPath, { cppSmartPointers: cfg.cppSmartPointers });
      }
    }
    if (raw.length) all.push(...resolveEdges(raw, symbolIndex, noteIndex));
  }
  // type -> set of its method names, derived from goMethodIndex keys (`Type#method`). Drives interface
  // satisfaction in resolveGoDispatch.
  const goTypeMethodSets = new Map();
  for (const k of goMethodIndex.keys()) {
    const hash = k.indexOf("#");
    if (hash < 0) continue;
    const t = k.slice(0, hash), meth = k.slice(hash + 1);
    if (!goTypeMethodSets.has(t)) goTypeMethodSets.set(t, new Set());
    goTypeMethodSets.get(t).add(meth);
  }
  all = resolveGoMethods(all, goMethodIndex);
  all = resolveGoDispatch(all, goMethodIndex, goInterfaceIndex, goTypeMethodSets);
  // base -> Set(all transitively-derived classes). Invert cppBaseIndex (child->bases) and close over
  // the chain, cycle-guarded, so a call on a base resolves to derived overrides at any depth.
  const cppDerivedIndex = new Map();
  for (const child of cppBaseIndex.keys()) {
    const seen = new Set();
    const stack = [...(cppBaseIndex.get(child) || [])];
    while (stack.length) {
      const base = stack.pop();
      if (seen.has(base) || base === child) continue;   // skip self (a cycle never makes a class its own derived)
      seen.add(base);
      if (!cppDerivedIndex.has(base)) cppDerivedIndex.set(base, new Set());
      cppDerivedIndex.get(base).add(child);
      for (const grand of (cppBaseIndex.get(base) || [])) stack.push(grand);
    }
  }
  all = resolveCppFieldReceivers(all, cppFieldIndex, cppBaseIndex);
  all = resolveCppDispatch(all, cppMethodIndex, cppDerivedIndex, cppVirtualMethods, cppOverrideMethods);
  all = resolveCppMethods(all, cppMethodIndex, cppReturnIndex);
  all = resolveTsMethods(all, tsClassFiles, tsCallableFiles);
  if (chunkByPath.size) {
    all = all.map((e) => {
      if (e.kind !== "calls" || e.conf !== "ambiguous" || e.content_hash) return e;
      const chunks = chunkByPath.get(e.from_path) ?? [];
      const line = Number(String(e.from_lines).split("-")[0]);
      const chunk = chunks.find((c) => line >= c.line_start && line <= c.line_end)
        ?? chunks.reduce((best, c) => (!best || Math.abs(c.line_start - line) < Math.abs(best.line_start - line) ? c : best), null);
      return chunk ? { ...e, content_hash: chunk.content_hash } : e;
    });
  }
  if (cfg.disambiguate !== false && all.length) {
    const importMap = new Map();
    for (const e of all) {
      if (e.kind === "imports" && e.to_path) {
        let s = importMap.get(e.from_path);
        if (!s) { s = new Set(); importMap.set(e.from_path, s); }
        s.add(e.to_path);
      }
    }
    all = disambiguateEdges(all, { symbolIndex, callSiteVec, importMap,
      threshold: cfg.disambigThreshold, margin: cfg.disambigMargin });
  }
  await store.evictEdgePaths([...reExtract, ...deletedSet]);
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
    if (!rebuild) {
      const ecols = await store.edgeColumns();
      if (ecols && !ecols.has("score")) { rebuild = true; schemaHealed = true; }
    }
  }

  // Targeted refresh: when the caller (the file-watcher) hands us the exact changed paths, stat
  // just those instead of walking the whole tree — O(changed), not O(files on disk). Empty/absent
  // paths or a rebuild fall back to the full walk: hooks, manual `refresh`, and the watcher's
  // startup catch-up (which must see everything that changed while it was off).
  const targeted = !rebuild && Array.isArray(paths) && paths.length > 0;
  const scan = targeted ? statPaths(cfg, paths) : { files: walkRepo(cfg), missing: null };
  const files = scan.files;
  const live = new Set(files.map((f) => f.relPath));

  // Auto-select the embedding model from the file mix (a notes vault → nomic) unless the user pinned
  // one. Only on a full walk — a targeted watcher refresh trusts the already-persisted choice. A model
  // flip on an existing index forces a rebuild (embedding dim changes, so vectors must be re-embedded).
  if (!targeted) {
    const auto = resolveAutoModel(cfg, files.map((f) => f.relPath));
    if (auto !== cfg.model) {
      cfg.model = auto;
      if (tableExists) {
        const metaModel = (await store.readMeta()).model;
        if (metaModel && metaModel !== cfg.model) rebuild = true;
      }
    }
  }

  const manifest = rebuild ? {} : await store.loadManifest();

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
  let stale = [];
  if (!rebuild) {
    stale = targeted
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
    // Nothing to (re)embed, but deletions still require edge re-resolution of the callers that
    // referenced the deleted files (else they keep stale resolved/inferred edges). Preserve meta.
    if (!rebuild && stale.length) {
      try { await indexEdges(cfg, store, [], { rebuild: false, deleted: stale }); }
      catch (e) { warnings.push(`edge index skipped: ${e.message}`); }
    }
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
  // scope_json carries the chunker's enclosing-scope breadcrumb so resolveCppMethods can key an
  // in-class method that was split out of its class chunk (#8). Optional like content_hash: only write
  // it on a fresh/rebuilt table or one that already has the column, so appending to a pre-scope table
  // (which lacks it) never trips a schema mismatch.
  const writeScope = rebuild || !tableExists || (await store.chunkColumns())?.has("scope_json") === true;
  const rows = allChunks.map((c, i) => ({
    id: stableId(c), path: c.path, language: c.language,
    chunk_start: c.chunkStart, chunk_end: c.chunkEnd,
    line_start: c.lineStart, line_end: c.lineEnd,
    text: c.text, fts_text: ctx[i].ftsText,
    mtime_ms: c.mtimeMs, embedding: vecs[i],
    ...(writeHash ? { content_hash: hashes[i] } : {}),
    ...(writeScope ? { scope_json: JSON.stringify(c.scope ?? []) } : {}),
  }));
  await store.upsertRows(rows);
  await store.writeMeta({ model: cfg.model, dim, version: cfg.version });

  try { await indexEdges(cfg, store, toIndex, { rebuild, deleted: rebuild ? [] : stale }); }
  catch (e) { warnings.push(`edge index skipped: ${e.message}`); }

  return { scanned: files.length, skipped, evicted, chunks: rows.length, dim, reused, embedded, warnings };
}
