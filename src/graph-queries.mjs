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

// Full defined-symbol inventory, rebuilt at query time. When symbols_json is present (and not in
// callables mode), uses precise per-symbol line spans from the stored column; otherwise falls back
// to the declaredSymbols heuristic over chunk text. Notes mode: one entry per note file.
export async function buildSymbolInventory(store, mode, { callables = false } = {}) {
  const hasSymbols = !callables && (await store.chunkColumns())?.has("symbols_json") === true;
  const cols = hasSymbols
    ? ["path", "line_start", "line_end", "text", "symbols_json"]
    : ["path", "line_start", "line_end", "text"];
  const rows = await store.allChunkRows(cols);
  const flat = [];
  if (mode === "notes") {
    const seen = new Set();
    for (const r of rows) { if (seen.has(r.path)) continue; seen.add(r.path); flat.push({ name: noteName(r.path), path: r.path }); }
  } else {
    const declared = callables ? declaredCallables : declaredSymbols;
    const seen = new Set();
    for (const r of rows) {
      const entries = hasSymbols ? parseSymbols(r.symbols_json) : null;
      if (entries && entries.length) {
        const chunkLineStart = Number(r.line_start);
        for (const s of entries) {
          if (!s || !s.name) continue;
          const k = `${r.path}#${s.name}`;
          if (seen.has(k)) continue; seen.add(k);
          // Guard legacy/corrupt spans: a non-positive or inverted range yields no line label
          // (avoids rendering "0--1") and falls back to the whole chunk for text.
          const ls = Number(s.lineStart), le = Number(s.lineEnd);
          const valid = Number.isInteger(ls) && Number.isInteger(le) && ls > 0 && le >= ls;
          flat.push({
            name: s.name, path: r.path,
            line_start: valid ? ls : undefined,
            line_end: valid ? le : undefined,
            text: valid ? sliceByLines(r.text, chunkLineStart, ls, le) : String(r.text || ""),
          });
        }
      } else {
        for (const name of declared(r.text)) {
          const k = `${r.path}#${name}`;
          if (seen.has(k)) continue; seen.add(k);
          flat.push({ name, path: r.path, line_start: Number(r.line_start), line_end: Number(r.line_end), text: r.text });
        }
      }
    }
  }
  return { flat, byName: indexByName(flat) };
}

// Parse a stored symbols_json array; never throw on malformed/legacy values.
function parseSymbols(json) {
  if (!json) return null;
  try { const a = JSON.parse(json); return Array.isArray(a) ? a : null; } catch { return null; }
}

// Slice a chunk's text to a symbol's file-line span. Chunk text line 0 == chunkLineStart. Deterministic
// per chunk (so baseline and check produce the same slice — no spurious drift). Out-of-range → whole chunk.
function sliceByLines(chunkText, chunkLineStart, lineStart, lineEnd) {
  const whole = String(chunkText || "");
  // A symbol starting before this chunk is out-of-range → whole chunk (don't return a truncated
  // top-of-chunk slice when lineStart clamps to 0 but lineEnd lands inside).
  if (!(lineStart >= chunkLineStart)) return whole;
  const lines = whole.split("\n");
  const a = lineStart - chunkLineStart;
  const b = Math.min(lines.length, lineEnd - chunkLineStart + 1);
  return a < b ? lines.slice(a, b).join("\n") : whole;
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
  if (!from) return { from, to, path: null, steps: null, error: "from symbol is required" };
  if (!to) return { from, to, path: null, steps: null, error: "to symbol is required" };
  const store = await openStore(cfg);
  const mode = isNotesMode(cfg) ? "notes" : "code";
  const { graph, hasEdges } = await loadGraph(store, includeAmbiguous);
  if (!hasEdges) return { from, to, path: null, steps: null, error: "no edge index — run: gtir index" };
  const inv = await buildSymbolInventory(store, mode);
  let fromSites = inv.byName.get(from) || [];
  if (fromPath) fromSites = fromSites.filter((s) => s.path.includes(fromPath));
  if (fromSites.length === 0) return { from, to, path: null, steps: null, error: `symbol '${from}' not found` };
  let toSites = inv.byName.get(to) || [];
  if (toPath) toSites = toSites.filter((s) => s.path.includes(toPath));
  if (toSites.length === 0) return { from, to, path: null, steps: null, error: `symbol '${to}' not found` };
  const fromKeys = fromSites.map((s) => nodeKey(s.path, s.name || null));
  const toKeys = new Set(toSites.map((s) => nodeKey(s.path, s.name || null)));
  const maxDepth = Number.isFinite(depth) ? depth : Infinity;
  const foundPath = pathBetween(graph, fromKeys, toKeys, { maxDepth });
  const steps = foundPath ? foundPath.map((key) => {
    const h = key.indexOf("#");
    return h >= 0 ? { symbol: key.slice(h + 1), path: key.slice(0, h) } : { symbol: null, path: key };
  }) : null;
  return { from, to, path: foundPath, steps };
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
