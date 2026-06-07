// src/graph-retrieval.mjs — pure bridge from a result chunk to the edge graph.
// Imports only declaredSymbols (no store, no graph-queries) so search.mjs can use it without a cycle.
import { declaredSymbols } from "./symbols.mjs";

// Raw centrality of a chunk: max call-degree among the symbols it declares, vs the file's import
// in-degree. 0 when the chunk declares no edged symbols and its file is not imported.
export function chunkCentrality(text, path, degree) {
  let m = degree.importIn.get(path) || 0;
  for (const name of declaredSymbols(text)) {
    const d = degree.call.get(`${path}#${name}`) || 0;
    if (d > m) m = d;
  }
  return m;
}

// Gentle saturating multiplier in [1, 1+weight]. K sets the half-saturation degree.
export function centralityMultiplier(text, path, degree, { weight = 0.15, K = 8 } = {}) {
  const c = chunkCentrality(text, path, degree);
  if (c <= 0) return 1;
  return 1 + weight * (c / (c + K));
}

// Tiebreaker-only centrality (pure). Reorders hits ONLY within bands of near-equal RRF score
// (consecutive items within `eps` of the band's leading score); inside each band, higher centrality
// leads. Never crosses a real score gap — exact matches keep their rank, so this cannot demote a
// relevant top hit (measured: the score-multiplier variant cost ~4.5pp recall@1; this is neutral).
// Scores are left unchanged; `centrality` is annotated on items whose multiplier ≠ 1. Does NOT
// slice — the caller slices to k afterward. Assumes hits are already sorted by score desc.
// NOTE: fuseRRF rounds scores to 4 decimals, so in practice this band fires only on post-rounding
// ties — eps just needs to be < the rounding step (1e-4). The 1e-6 default keeps that property even
// if a caller omits it; never raise it above the inter-rank RRF gap (~2.6e-4) or exact matches demote.
export function applyCentrality(hits, degree, { weight = 0.15, K = 8, eps = 0.000001 } = {}) {
  const withC = hits.map((h) => ({ h, c: centralityMultiplier(h.snippet ?? "", h.path, degree, { weight, K }) }));
  const out = [];
  for (let i = 0; i < withC.length;) {
    let j = i + 1;
    while (j < withC.length && Math.abs(withC[i].h.score - withC[j].h.score) < eps) j++;
    const band = withC.slice(i, j).sort((a, b) => b.c - a.c);
    for (const { h, c } of band) out.push(c !== 1 ? { ...h, centrality: Number(c.toFixed(3)) } : h);
    i = j;
  }
  return out;
}

// Callers/callees of the symbols a chunk declares (precise path#symbol keys), each capped.
export function contextFor(text, path, graph, { cap = 5 } = {}) {
  const callers = new Set(), callees = new Set();
  for (const name of declaredSymbols(text)) {
    const key = `${path}#${name}`;
    for (const c of (graph.rev.get(key) || [])) callers.add(c);
    for (const c of (graph.fwd.get(key) || [])) callees.add(c);
  }
  const fmt = (s) => [...s].slice(0, cap).map((k) => {
    const m = graph.nodeMeta.get(k);
    return { path: m?.path ?? k, symbol: m?.symbol ?? null };
  });
  return { callers: fmt(callers), callees: fmt(callees) };
}
