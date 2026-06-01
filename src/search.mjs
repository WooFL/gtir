import { openStore } from "./store.mjs";
import { embedTexts } from "./embed.mjs";
import { rerankDocs } from "./rerank.mjs";

const RRF_K = 60; // canonical default (Cormack et al.), as in the original server.mjs

// A "symbol-like" query is a single bare identifier (fetchWithRetry, LRUCache,
// grid_shortest_path) — an exact-lookup intent where BM25 should lead. Natural-language
// queries are multi-word and never match. Used to pick the fusion weight per query.
export function isSymbolQuery(query) {
  return /^[A-Za-z_$][\w$]*$/.test(String(query).trim());
}

// Pure fusion — unit-tested without a DB. Port of server.mjs bump()/RRF loop.
// ftsWeight scales the BM25 branch's RRF contribution relative to the vector branch
// (1 = equal/classic RRF; <1 favors the embedder). The dense branch is the stronger
// signal on conceptual/cross-vocabulary queries; BM25 still wins exact-symbol lookups
// even at a low weight because its rank-1 signal there is unambiguous.
export function fuseRRF(vecRows, ftsRows, limit, ftsWeight = 1) {
  const fused = new Map();
  const bump = (rows, key, weight) => rows.forEach((r, i) => {
    const cur = fused.get(r.id) ?? { row: r, rrf: 0, vec_rank: null, fts_rank: null };
    cur.rrf += weight / (RRF_K + i + 1);
    cur[key] = i + 1;
    fused.set(r.id, cur);
  });
  bump(vecRows, "vec_rank", 1);
  bump(ftsRows, "fts_rank", ftsWeight);
  return [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map(({ row: r, rrf, vec_rank, fts_rank }) => ({
      path: r.path, lines: `${r.line_start}-${r.line_end}`, language: r.language,
      score: Number(rrf.toFixed(4)), vec_rank, fts_rank, snippet: r.text,
    }));
}

// Pure reorder of fused RRF rows by a reranker's [{index, score}] list (best-first).
// Falls back to RRF order when `ranked` is null/empty; ignores out-of-range indices;
// appends any fused rows the reranker omitted, preserving RRF order. Then slices to k.
export function applyRerank(fused, ranked, limit) {
  if (!Array.isArray(ranked) || ranked.length === 0) return fused.slice(0, limit);
  const used = new Set();
  const out = [];
  for (const { index, score } of ranked) {
    if (fused[index] && !used.has(index)) {
      used.add(index);
      out.push({ ...fused[index], rerank_score: Number(score.toFixed(4)) });
    }
  }
  for (let i = 0; i < fused.length; i++) if (!used.has(i)) out.push(fused[i]);
  return out.slice(0, limit);
}

export async function search(query, cfg, { k = 8, pathPrefix = null, language = null } = {}) {
  if (!query || typeof query !== "string") throw new Error("query is required (string)");
  const store = await openStore(cfg);
  const tbl = await store.chunksTable();
  if (!tbl) throw new Error(`no index at ${cfg.indexDir} — run: gtir index`);

  const embed = cfg.embedImpl ?? ((t) => embedTexts(t, cfg));
  const [qvec] = await embed([query]);
  const limit = Math.max(1, Math.min(50, k | 0 || 8));
  const rcand = Math.min(50, cfg.rerankCandidates ?? 24);
  const fanout = Math.min(50, Math.max(limit * 3, 16, cfg.rerank ? rcand : 0));

  const filters = [];
  if (pathPrefix) filters.push(`path LIKE '${String(pathPrefix).replace(/'/g, "''")}%'`);
  if (language) filters.push(`language = '${String(language).replace(/'/g, "''")}'`);
  const where = filters.length ? filters.join(" AND ") : null;

  let vq = tbl.search(qvec).distanceType("cosine").limit(fanout);
  if (where) vq = vq.where(where);
  const vecRows = await vq.toArray();

  let ftsRows = [];
  const ftsSearch = async (cols) => {
    let fq = tbl.query().nearestToText(query, cols).limit(fanout);
    if (where) fq = fq.where(where);
    return fq.toArray();
  };
  try {
    ftsRows = await ftsSearch(["fts_text"]);          // boosted FTS column (current schema)
  } catch {
    try { ftsRows = await ftsSearch(undefined); }      // fall back to the default/single FTS index (old schema)
    catch (err) { process.stderr.write(`[gtir] FTS unavailable, vector-only: ${err.message}\n`); }
  }

  // Query-adaptive fusion: exact-symbol lookups let BM25 lead; conceptual queries let the embedder lead.
  const ftsW = isSymbolQuery(query) ? (cfg.ftsWeightSymbol ?? 1) : (cfg.ftsWeight ?? 1);
  const fused = fuseRRF(vecRows, ftsRows, cfg.rerank ? rcand : limit, ftsW);
  if (!cfg.rerank) return fused;
  const rerankImpl = cfg.rerankImpl ?? ((q, docs) => rerankDocs(q, docs, cfg));
  const ranked = await rerankImpl(query, fused.map((r) => r.snippet));
  return applyRerank(fused, ranked, limit);
}
