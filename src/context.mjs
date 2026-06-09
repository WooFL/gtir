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

// A target is a "path:lines" span when it has a ":" followed by a digit; otherwise a symbol name.
function isSpanTarget(t) { return /:\d/.test(String(t)); }

function parseSpan(t) {
  const i = String(t).lastIndexOf(":");
  const path = t.slice(0, i);
  const [s, e] = t.slice(i + 1).split("-").map((n) => Number(n));
  return { path, start: Number.isFinite(s) ? s : 1, end: Number.isFinite(e) ? e : (Number.isFinite(s) ? s : 1) };
}

// Read a file span from disk (guard path traversal), with optional context lines.
function readSpan(cfg, path, start, end, contextLines = 0) {
  const abs = resolve(cfg.repo, path);
  if (relative(cfg.repo, abs).startsWith("..")) throw new Error("path escapes the repo");
  const body = readFileSync(abs, "utf8").split("\n");
  const ctxN = Math.max(0, Math.min(50, contextLines | 0 || 0));
  const a = Math.max(1, start - ctxN), b = Math.min(body.length, Math.max(start, end) + ctxN);
  return { lines: `${a}-${b}`, text: body.slice(a - 1, b).join("\n") };
}

// One-line signature for a chunk (first non-blank line, trimmed + capped) — a cheap sibling label.
// (mcp.mjs has a private signatureOf but it isn't exported; importing it here would create a circular
// import mcp↔context, so context.mjs keeps its own tiny version.)
function sigLine(text) {
  const line = String(text || "").split("\n").map((l) => l.trim()).find((l) => l.length) || "";
  return line.length > 120 ? line.slice(0, 119) + "…" : line;
}

async function siblingsFor(store, path) {
  const rows = await store.chunksByPath(path);
  return rows.map((r) => ({ line_start: Number(r.line_start), line_end: Number(r.line_end), signature: sigLine(r.text) }));
}

async function buildTargetsContext(cfg, targets, contextLines) {
  const store = await openStore(cfg);
  const tbl = await store.chunksTable();
  if (!tbl) return { error: "no index — run: gtir index" };
  const mode = isNotesMode(cfg) ? "notes" : "code";
  const { graph } = await graphForSearch(cfg);
  const inv = await buildSymbolInventory(store, mode);
  const cap = cfg.contextCap ?? 5;

  const items = [];
  for (const t of targets) {
    try {
      if (isSpanTarget(t)) {
        const { path, start, end } = parseSpan(t);
        const span = readSpan(cfg, path, start, end, contextLines);
        items.push({
          path, lines: span.lines, language: cfg.language ?? null, source: span.text,
          ...contextFor(span.text, path, graph, { cap }),
          siblings: await siblingsFor(store, path),
        });
      } else {
        const sites = inv.byName.get(t) || [];
        if (sites.length === 0) { items.push({ target: t, error: "not found" }); continue; }
        for (const s of sites) {
          const lines = s.line_start != null ? `${s.line_start}-${s.line_end}` : null;
          items.push({
            path: s.path, lines, language: cfg.language ?? null, source: s.text,
            ...contextFor(s.text, s.path, graph, { cap }),
            siblings: await siblingsFor(store, s.path),
          });
        }
      }
    } catch (e) {
      items.push({ target: t, error: e.message });
    }
  }
  return { ...retrievalQuality(items, "targets", cfg), items };
}
