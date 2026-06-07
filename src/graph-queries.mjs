// src/graph-queries.mjs
import { basename } from "node:path";
import { declaredSymbols } from "./symbols.mjs";
import { openStore } from "./store.mjs";
import { isNotesMode } from "./search.mjs";
import { buildGraph, impact, cycles, orphans, nodeKey } from "./edge-graph.mjs";

const noteName = (p) => basename(String(p)).replace(/\.(md|mdx)$/i, "");

function indexByName(flat) {
  const m = new Map();
  for (const d of flat) { let a = m.get(d.name); if (!a) { a = []; m.set(d.name, a); } a.push(d); }
  return m;
}

// Full defined-symbol inventory, rebuilt at query time from chunk text (the same declaredSymbols
// heuristic the indexer uses). Returns { flat, byName }. Notes mode: one entry per note file.
export async function buildSymbolInventory(store, mode) {
  const rows = await store.allChunkRows(["path", "line_start", "line_end", "text"]);
  const flat = [];
  if (mode === "notes") {
    const seen = new Set();
    for (const r of rows) { if (seen.has(r.path)) continue; seen.add(r.path); flat.push({ name: noteName(r.path), path: r.path }); }
  } else {
    const seen = new Set();
    for (const r of rows) {
      for (const name of declaredSymbols(r.text)) {
        const k = `${r.path}#${name}`;
        if (seen.has(k)) continue; seen.add(k);
        flat.push({ name, path: r.path, line_start: Number(r.line_start), line_end: Number(r.line_end), text: r.text });
      }
    }
  }
  return { flat, byName: indexByName(flat) };
}

async function loadGraph(store, includeAmbiguous) {
  const hasEdges = await store.hasEdges();
  const edges = await store.loadEdges();
  return { graph: buildGraph(edges, { includeAmbiguous }), hasEdges };
}

const linesOf = (s) => (s.line_start != null ? `${s.line_start}-${s.line_end}` : undefined);

// Transitive blast radius for a symbol. Resolves the symbol (+ optional path) to its definition
// site(s) via the inventory, then walks the graph. Errors when the symbol is unknown or the index
// has no edges; returns { ambiguous } when the name maps to multiple files and no path is given.
export async function impactQuery(cfg, { symbol, path = null, downstream = false, depth, includeAmbiguous = false, limit } = {}) {
  if (!symbol) return { error: "symbol is required" };
  const store = await openStore(cfg);
  const mode = isNotesMode(cfg) ? "notes" : "code";
  const { graph, hasEdges } = await loadGraph(store, includeAmbiguous);
  if (!hasEdges) return { error: "no edge index — run: gtir index" };
  const inv = await buildSymbolInventory(store, mode);
  let sites = inv.byName.get(symbol) || [];
  if (path) sites = sites.filter((s) => s.path === path);
  if (sites.length === 0) return { error: `symbol '${symbol}' not found` };
  if (sites.length > 1 && !path) {
    return { ambiguous: sites.map((s) => ({ path: s.path, lines: linesOf(s) })), hint: "narrow with --path <file>" };
  }
  const startKeys = sites.map((s) => nodeKey(s.path, s.name || null));
  const direction = downstream ? "downstream" : "upstream";
  const { nodes, truncated } = impact(graph, startKeys, {
    direction,
    depth: Number.isFinite(depth) ? depth : Infinity,
    limit: Number.isFinite(limit) ? limit : 500,
  });
  return { symbol, path: sites[0].path, direction, count: nodes.length, truncated, nodes };
}

// Likely-dead symbols (no inbound edges), entrypoints filtered out heuristically.
export async function orphansQuery(cfg, { includeAmbiguous = false } = {}) {
  const store = await openStore(cfg);
  const mode = isNotesMode(cfg) ? "notes" : "code";
  const { graph, hasEdges } = await loadGraph(store, includeAmbiguous);
  if (!hasEdges) return { error: "no edge index — run: gtir index" };
  const inv = await buildSymbolInventory(store, mode);
  const r = orphans(inv.flat, graph, { includeAmbiguous });
  return { ...r, counts: { likely_dead: r.likely_dead.length, possible_entrypoint: r.possible_entrypoint.length } };
}

// Circular dependencies (call + import + link cycles).
export async function cyclesQuery(cfg, { includeAmbiguous = false } = {}) {
  const store = await openStore(cfg);
  const { graph, hasEdges } = await loadGraph(store, includeAmbiguous);
  if (!hasEdges) return { error: "no edge index — run: gtir index" };
  return cycles(graph);
}
