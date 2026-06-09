// src/graph-queries.mjs
import { basename } from "node:path";
import { declaredSymbols, declaredCallables } from "./symbols.mjs";
import { openStore } from "./store.mjs";
import { isNotesMode } from "./search.mjs";
import { buildGraph, impact, cycles, orphans, nodeKey, degreeMap, pathBetween } from "./edge-graph.mjs";

const noteName = (p) => basename(String(p)).replace(/\.(md|mdx)$/i, "");

function indexByName(flat) {
  const m = new Map();
  for (const d of flat) { let a = m.get(d.name); if (!a) { a = []; m.set(d.name, a); } a.push(d); }
  return m;
}

// Full defined-symbol inventory, rebuilt at query time from chunk text (the same declaredSymbols
// heuristic the indexer uses). Returns { flat, byName }. Notes mode: one entry per note file.
export async function buildSymbolInventory(store, mode, { callables = false } = {}) {
  const rows = await store.allChunkRows(["path", "line_start", "line_end", "text"]);
  const flat = [];
  if (mode === "notes") {
    const seen = new Set();
    for (const r of rows) { if (seen.has(r.path)) continue; seen.add(r.path); flat.push({ name: noteName(r.path), path: r.path }); }
  } else {
    const declared = callables ? declaredCallables : declaredSymbols;
    const seen = new Set();
    for (const r of rows) {
      for (const name of declared(r.text)) {
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

// Shortest call-path from one symbol to another. Mirrors impactQuery: same loader, same resolution.
// Returns { from, to, path: string[]|null } or { from, to, path: null, error: string } when a
// symbol is not found. from/to are raw symbol names; fromPath/toPath substring-filter candidates.
export async function pathQuery(cfg, { from, to, fromPath = null, toPath = null, depth, includeAmbiguous = false } = {}) {
  if (!from) return { from, to, path: null, error: "from symbol is required" };
  if (!to) return { from, to, path: null, error: "to symbol is required" };
  const store = await openStore(cfg);
  const mode = isNotesMode(cfg) ? "notes" : "code";
  const { graph, hasEdges } = await loadGraph(store, includeAmbiguous);
  if (!hasEdges) return { from, to, path: null, error: "no edge index — run: gtir index" };
  const inv = await buildSymbolInventory(store, mode);
  let fromSites = inv.byName.get(from) || [];
  if (fromPath) fromSites = fromSites.filter((s) => s.path.includes(fromPath));
  if (fromSites.length === 0) return { from, to, path: null, error: `symbol '${from}' not found` };
  let toSites = inv.byName.get(to) || [];
  if (toPath) toSites = toSites.filter((s) => s.path.includes(toPath));
  if (toSites.length === 0) return { from, to, path: null, error: `symbol '${to}' not found` };
  const fromKeys = fromSites.map((s) => nodeKey(s.path, s.name || null));
  const toKeys = new Set(toSites.map((s) => nodeKey(s.path, s.name || null)));
  const maxDepth = Number.isFinite(depth) ? depth : Infinity;
  const foundPath = pathBetween(graph, fromKeys, toKeys, { maxDepth });
  return { from, to, path: foundPath };
}

// Likely-dead symbols (no inbound edges), entrypoints filtered out heuristically.
export async function orphansQuery(cfg) {
  const store = await openStore(cfg);
  const mode = isNotesMode(cfg) ? "notes" : "code";
  const { graph, hasEdges } = await loadGraph(store, true); // count ambiguous inbound as referenced
  if (!hasEdges) return { error: "no edge index — run: gtir index" };
  const inv = await buildSymbolInventory(store, mode, { callables: true });
  const r = orphans(inv.flat, graph, {});
  return { ...r, counts: { likely_dead: r.likely_dead.length, possible_entrypoint: r.possible_entrypoint.length } };
}

// Circular dependencies (call + import + link cycles).
export async function cyclesQuery(cfg, { includeAmbiguous = false } = {}) {
  const store = await openStore(cfg);
  const { graph, hasEdges } = await loadGraph(store, includeAmbiguous);
  if (!hasEdges) return { error: "no edge index — run: gtir index" };
  return cycles(graph);
}

const _graphCache = new Map(); // indexDir -> { graph, degree }

// Build (once per indexDir) the graph + degree maps used by centrality/context at search time.
// Empty edges → empty graph (degrees 0) → the search flags become no-ops. Cached for the process
// lifetime (like adjCache in mcp.mjs); rebuilt on restart or after clearGraphCache.
export async function graphForSearch(cfg) {
  const key = cfg.indexDir;
  if (_graphCache.has(key)) return _graphCache.get(key);
  const store = await openStore(cfg);
  const graph = buildGraph(await store.loadEdges());
  const degree = {
    call: degreeMap(graph, { kinds: ["calls"] }),
    importIn: degreeMap(graph, { kinds: ["imports"], direction: "in" }),
  };
  const entry = { graph, degree };
  _graphCache.set(key, entry);
  return entry;
}
export function clearGraphCache(indexDir) { indexDir ? _graphCache.delete(indexDir) : _graphCache.clear(); }
