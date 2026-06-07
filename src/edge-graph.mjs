// src/edge-graph.mjs

// Node identity. Symbol node = `${path}#${symbol}`; file node = `${path}` (top-level calls,
// imports, notes links/embeds). Fixes the bare-name collision in edges.mjs buildAdjacency,
// which keys callers/callees by symbol name alone (two `parse`s in different files collide).
export function nodeKey(path, symbol) {
  return symbol ? `${path}#${symbol}` : `${path}`;
}

// Map one edge row to directed graph links { src, dst, kind, conf }. External edges and
// (by default) ambiguous edges are dropped. An ambiguous call fans out to one link per candidate.
function edgeToLinks(e, includeAmbiguous) {
  if (e.conf === "external") return [];
  if (e.conf === "ambiguous" && !includeAmbiguous) return [];
  if (e.kind === "calls") {
    const src = nodeKey(e.from_path, e.from_symbol || null);
    if (e.conf === "resolved") {
      if (!e.to_path || !e.to_symbol) return [];
      return [{ src, dst: nodeKey(e.to_path, e.to_symbol), kind: "calls", conf: "resolved" }];
    }
    const name = e.ref_name;
    if (!name || !Array.isArray(e.candidates)) return [];
    return e.candidates.map((p) => ({ src, dst: nodeKey(p, name), kind: "calls", conf: "ambiguous" }));
  }
  if (e.kind === "imports" || e.kind === "links" || e.kind === "embeds") {
    if (!e.to_path) return []; // unresolved import/link: no in-repo target
    return [{ src: nodeKey(e.from_path, null), dst: nodeKey(e.to_path, null), kind: e.kind, conf: e.conf }];
  }
  return [];
}

// Build a directed graph from edge rows.
// Returns { edgeList:[{src,dst,kind,conf}], fwd:Map(key->Set), rev:Map(key->Set), nodeMeta:Map(key->{path,symbol,kinds:Set}) }.
export function buildGraph(edges, { includeAmbiguous = false } = {}) {
  const edgeList = [];
  const fwd = new Map();
  const rev = new Map();
  const nodeMeta = new Map();
  const meta = (key) => {
    let m = nodeMeta.get(key);
    if (!m) {
      const h = key.indexOf("#");
      m = { path: h >= 0 ? key.slice(0, h) : key, symbol: h >= 0 ? key.slice(h + 1) : null, kinds: new Set() };
      nodeMeta.set(key, m);
    }
    return m;
  };
  const addAdj = (map, a, b) => { let s = map.get(a); if (!s) { s = new Set(); map.set(a, s); } s.add(b); };
  for (const e of edges) {
    for (const lk of edgeToLinks(e, includeAmbiguous)) {
      edgeList.push(lk);
      meta(lk.src).kinds.add(lk.kind);
      meta(lk.dst).kinds.add(lk.kind);
      addAdj(fwd, lk.src, lk.dst);
      addAdj(rev, lk.dst, lk.src);
    }
  }
  return { edgeList, fwd, rev, nodeMeta };
}
