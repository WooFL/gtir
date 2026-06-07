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

// Transitive reachability from startKeys. direction "upstream" walks rev (callers),
// "downstream" walks fwd (callees). BFS records hop distance; dedup via visited; the start
// nodes are excluded from output. Stops a branch at `depth` and overall at `limit` (truncated).
export function impact(graph, startKeys, { direction = "upstream", depth = Infinity, limit = 500 } = {}) {
  const adj = direction === "downstream" ? graph.fwd : graph.rev;
  const visited = new Set(startKeys);
  const out = [];
  let frontier = [...startKeys];
  let truncated = false;
  for (let d = 1; frontier.length && d <= depth; d++) {
    const next = [];
    for (const k of frontier) {
      for (const nb of (adj.get(k) || [])) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        const m = graph.nodeMeta.get(nb) || { path: nb, symbol: null };
        out.push({ key: nb, path: m.path, symbol: m.symbol, depth: d });
        next.push(nb);
        if (out.length >= limit) { truncated = true; break; }
      }
      if (truncated) break;
    }
    if (truncated) break;
    frontier = next;
  }
  out.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
  return { nodes: out, truncated };
}

// Tarjan strongly-connected components over an adjacency Map restricted to `nodes`.
// Recursive — fine at gtir's scale (thousands of nodes, well under V8's frame limit).
function tarjanSCC(nodes, adj) {
  let counter = 0;
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [];
  const sccs = [];
  const connect = (v) => {
    index.set(v, counter); low.set(v, counter); counter++;
    stack.push(v); onStack.add(v);
    for (const w of (adj.get(v) || [])) {
      if (!nodes.has(w)) continue;
      if (!index.has(w)) { connect(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      sccs.push(comp);
    }
  };
  for (const v of nodes) if (!index.has(v)) connect(v);
  return sccs;
}

// Shortest closed walk through `start` within the induced subgraph on `comp` (BFS).
// Returns [start, ..., closing, start]; defensively [start] if no cycle (won't happen for |SCC|>1).
function shortestCycleThrough(start, comp, adj) {
  const inComp = new Set(comp);
  const prev = new Map([[start, null]]);
  let closing = null;
  const q = [start];
  bfs: while (q.length) {
    const v = q.shift();
    for (const w of (adj.get(v) || [])) {
      if (!inComp.has(w)) continue;
      if (w === start) { closing = v; break bfs; }
      if (!prev.has(w)) { prev.set(w, v); q.push(w); }
    }
  }
  if (closing === null) return [start];
  const path = [];
  for (let v = closing; v !== null; v = prev.get(v)) path.push(v);
  path.reverse();              // start ... closing
  return path.concat(start);   // start ... closing start
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

const TEST_PATH = /(^|[/\\])(tests?|__tests__|__mocks__|specs?|e2e)[/\\]/i;
const TEST_FILE = /(^|[/\\._-])(test|spec)\.[a-z0-9]+$/i;
const PYTEST = /(^|[/\\])test_[^/\\]*\.py$/i;
const ENTRY_FILE = /(^|[/\\])(bin[/\\]|main\.|index\.|cli\.|readme\.|home\.)/i;
const ENTRY_NAME = /^(main|default|handler|setup|run|init)$/;
const HANDLER = /^(on|handle)[A-Z]/;

// Heuristic: is `name` defined in `path` (with chunk `text`) a likely entrypoint rather than dead code?
// Returns { entrypoint, reason }.
export function classifyEntrypoint(name, path, text) {
  const p = String(path || ""), t = String(text || ""), n = String(name || "");
  if (TEST_PATH.test(p) || TEST_FILE.test(p) || PYTEST.test(p)) return { entrypoint: true, reason: "test path" };
  if (ENTRY_FILE.test(p)) return { entrypoint: true, reason: "entry file" };
  if (ENTRY_NAME.test(n) || HANDLER.test(n)) return { entrypoint: true, reason: "entry/handler name" };
  if (n) {
    const exp = new RegExp(
      `\\bexport\\b[^\\n]*\\b${escapeRe(n)}\\b` +
      `|\\bmodule\\.exports\\b|\\bexport\\s+default\\b|\\b__all__\\b` +
      `|\\bpub\\s+(?:fn|struct|enum|trait|mod|const)\\b[^\\n]*\\b${escapeRe(n)}\\b`);
    if (exp.test(t)) return { entrypoint: true, reason: "exported" };
  }
  if (/\.go$/i.test(p) && /^[A-Z]/.test(n)) return { entrypoint: true, reason: "go exported" };
  return { entrypoint: false, reason: null };
}

// Dead-code analysis. `inventory` is the full defined-symbol list (code: {name,path,line_start,line_end,text};
// notes: {name,path}). A symbol is an orphan candidate when its inbound (graph.rev) set is empty.
// includeAmbiguous is already reflected in graph.rev when the graph was built with that flag.
export function orphans(inventory, graph, { includeAmbiguous = false } = {}) {
  // includeAmbiguous is intentionally not read here: it was already applied to `graph.rev`
  // when buildGraph(edges, { includeAmbiguous }) ran. Accepted only so callers can pass it through.
  void includeAmbiguous;
  const likely_dead = [], possible_entrypoint = [];
  for (const def of inventory) {
    const key = nodeKey(def.path, def.name || null);
    const inbound = graph.rev.get(key);
    if (inbound && inbound.size > 0) continue;
    const lines = def.line_start != null ? `${def.line_start}-${def.line_end}` : undefined;
    const base = { path: def.path, symbol: def.name, ...(lines ? { lines } : {}) };
    const cls = classifyEntrypoint(def.name, def.path, def.text);
    if (cls.entrypoint) possible_entrypoint.push({ ...base, reason: cls.reason });
    else likely_dead.push(base);
  }
  likely_dead.sort((a, b) => a.path.localeCompare(b.path) || (a.lines || "").localeCompare(b.lines || ""));
  possible_entrypoint.sort((a, b) => a.path.localeCompare(b.path) || (a.lines || "").localeCompare(b.lines || ""));
  return { likely_dead, possible_entrypoint };
}

// Circular dependencies, split by edge class. SCCs of size>1 are cycles; size-1 SCCs with a
// self-edge are counted as excluded self-recursion (intended, not a smell).
export function cycles(graph) {
  const classes = [
    ["call_cycles", (k) => k === "calls"],
    ["import_cycles", (k) => k === "imports"],
    ["link_cycles", (k) => k === "links" || k === "embeds"],
  ];
  const result = { call_cycles: [], import_cycles: [], link_cycles: [], excluded_self_recursive: 0 };
  for (const [outKey, pred] of classes) {
    const adj = new Map();
    const nodes = new Set();
    for (const e of graph.edgeList) {
      if (!pred(e.kind)) continue;
      nodes.add(e.src); nodes.add(e.dst);
      if (e.src === e.dst) { result.excluded_self_recursive++; continue; }
      let s = adj.get(e.src); if (!s) { s = new Set(); adj.set(e.src, s); } s.add(e.dst);
    }
    for (const comp of tarjanSCC(nodes, adj)) {
      if (comp.length < 2) continue;
      const members = comp.slice().sort();
      result[outKey].push({ members, example: shortestCycleThrough(members[0], comp, adj) });
    }
    result[outKey].sort((a, b) => a.members[0].localeCompare(b.members[0]));
  }
  return result;
}
