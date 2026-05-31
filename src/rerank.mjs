// Cross-encoder rerank client for llama.cpp llama-server (--reranking, /rerank endpoint).
// Mirrors embed.mjs: fetchImpl-injectable, and NEVER throws fatally — returns null on any
// failure so search() can fall back to hybrid (RRF) order, like the FTS-unavailable path.

export async function rerankDocs(query, docs, cfg) {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const cap = cfg.rerankMaxChars ?? 2000;
  try {
    const res = await fetchImpl(`${cfg.rerankUrl}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.rerankModel,
        query,
        documents: docs.map((d) => String(d).slice(0, cap)),
        top_n: docs.length,
      }),
    });
    if (!res.ok) {
      process.stderr.write(`[gtir] rerank unavailable (HTTP ${res.status}), using hybrid order\n`);
      return null;
    }
    const data = await res.json();
    const results = Array.isArray(data) ? data : data.results;
    if (!Array.isArray(results)) return null;
    return results
      .map((r) => ({ index: r.index, score: r.relevance_score ?? r.score ?? 0 }))
      .filter((r) => Number.isInteger(r.index))
      .sort((a, b) => b.score - a.score);
  } catch (err) {
    process.stderr.write(`[gtir] rerank unavailable (${err.message}), using hybrid order\n`);
    return null;
  }
}
