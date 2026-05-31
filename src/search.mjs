import { openStore } from "./store.mjs";
import { embedTexts } from "./embed.mjs";

const RRF_K = 60; // canonical default (Cormack et al.), as in the original server.mjs

// Pure fusion — unit-tested without a DB. Port of server.mjs bump()/RRF loop.
export function fuseRRF(vecRows, ftsRows, limit) {
  const fused = new Map();
  const bump = (rows, key) => rows.forEach((r, i) => {
    const cur = fused.get(r.id) ?? { row: r, rrf: 0, vec_rank: null, fts_rank: null };
    cur.rrf += 1 / (RRF_K + i + 1);
    cur[key] = i + 1;
    fused.set(r.id, cur);
  });
  bump(vecRows, "vec_rank");
  bump(ftsRows, "fts_rank");
  return [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map(({ row: r, rrf, vec_rank, fts_rank }) => ({
      path: r.path, lines: `${r.line_start}-${r.line_end}`, language: r.language,
      score: Number(rrf.toFixed(4)), vec_rank, fts_rank, snippet: r.text,
    }));
}

export async function search(query, cfg, { k = 8, pathPrefix = null, language = null } = {}) {
  if (!query || typeof query !== "string") throw new Error("query is required (string)");
  const store = await openStore(cfg);
  const tbl = await store.chunksTable();
  if (!tbl) throw new Error(`no index at ${cfg.indexDir} — run: gtir index`);

  const embed = cfg.embedImpl ?? ((t) => embedTexts(t, cfg));
  const [qvec] = await embed([query]);
  const limit = Math.max(1, Math.min(50, k | 0 || 8));
  const fanout = Math.min(50, Math.max(limit * 3, 16));

  const filters = [];
  if (pathPrefix) filters.push(`path LIKE '${String(pathPrefix).replace(/'/g, "''")}%'`);
  if (language) filters.push(`language = '${String(language).replace(/'/g, "''")}'`);
  const where = filters.length ? filters.join(" AND ") : null;

  let vq = tbl.search(qvec).distanceType("cosine").limit(fanout);
  if (where) vq = vq.where(where);
  const vecRows = await vq.toArray();

  let ftsRows = [];
  try {
    let fq = tbl.query().nearestToText(query).limit(fanout);
    if (where) fq = fq.where(where);
    ftsRows = await fq.toArray();
  } catch (err) {
    process.stderr.write(`[gtir] FTS unavailable, vector-only: ${err.message}\n`);
  }

  return fuseRRF(vecRows, ftsRows, limit);
}
