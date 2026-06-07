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

// Re-rank fused hits by centrality (pure): multiply each hit.score by its multiplier, re-sort desc,
// annotate `centrality` only when ≠1. Does NOT slice — the caller slices to k afterward.
export function applyCentrality(hits, degree, opts = {}) {
  const out = hits.map((h) => {
    const mult = centralityMultiplier(h.snippet ?? "", h.path, degree, opts);
    return { ...h, score: Number((h.score * mult).toFixed(4)),
      ...(mult !== 1 ? { centrality: Number(mult.toFixed(3)) } : {}) };
  });
  out.sort((a, b) => b.score - a.score);
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
