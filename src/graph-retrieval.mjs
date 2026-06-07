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
