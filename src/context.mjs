// src/context.mjs — the `context` task-shaped tool: bundle search/read/edges into one call,
// with a heuristic confidence signal. Reads existing index data; no new network path.
import { resolve, relative } from "node:path";
import { readFileSync } from "node:fs";
import { search, isNotesMode } from "./search.mjs";
import { graphForSearch, buildSymbolInventory } from "./graph-queries.mjs";
import { contextFor } from "./graph-retrieval.mjs";
import { openStore } from "./store.mjs";

// Heuristic, scale-independent confidence. Query mode uses the relative top-vs-#2 RRF margin;
// targets mode uses resolution success. Pure.
export function retrievalQuality(items, mode, cfg = {}) {
  const hi = cfg.contextMarginHigh ?? 0.30, lo = cfg.contextMarginLow ?? 0.08;
  let quality;
  if (mode === "targets") {
    const resolved = items.filter((i) => !i.error).length;
    quality = resolved === 0 ? "low" : resolved === items.length ? "high" : "medium";
  } else {
    const top = items[0]?.score ?? 0;
    if (items.length === 0 || top <= 0) {
      quality = "low";
    } else {
      const margin = (top - (items[1]?.score ?? 0)) / top;
      quality = margin >= hi ? "high" : margin < lo ? "low" : "medium";
      // a clear #1 vector hit with a non-trivial margin is high-confidence
      if (quality === "medium" && items[0]?.vec_rank === 1 && margin >= lo) quality = "high";
    }
  }
  return {
    retrieval_quality: quality,
    best_guesses: quality === "low",
    ...(quality === "low" ? { note: "weak or ambiguous match — verify before relying" } : {}),
  };
}

export async function buildContext(cfg, { query = null, targets = null, k, contextLines } = {}) {
  const hasTargets = Array.isArray(targets) && targets.length > 0;
  if (!query && !hasTargets) return { error: "query or targets required" };
  const K = Math.max(1, Math.min(20, (k ?? cfg.contextK ?? 5) | 0 || 5));

  if (query) {
    let hits;
    try {
      const graphData = await graphForSearch(cfg);
      hits = await search(query, cfg, { k: K, edges: true, graphData });
    } catch (e) {
      return { error: e.message };
    }
    const items = hits.map((h) => ({
      path: h.path, lines: h.lines, language: h.language, score: h.score, vec_rank: h.vec_rank,
      source: h.snippet, callers: h.callers ?? [], callees: h.callees ?? [],
    }));
    return { ...retrievalQuality(items, "query", cfg), items };
  }

  return await buildTargetsContext(cfg, targets, contextLines); // real impl in Task 4
}

// Temporary stub — replaced by the real resolver in Task 4. Keeps this task self-contained.
async function buildTargetsContext(_cfg, _targets, _contextLines) {
  return { ...retrievalQuality([], "targets"), items: [] };
}
