// Pure edge-graph shaping for `gtir graph`. No I/O — buildGraph/renderHtml take data in,
// return data/HTML out, so the whole module is unit-testable offline without a browser.

const NOTE_KINDS = new Set(["links", "embeds"]);

const base = (p) => String(p).split(/[\\/]/).pop();
const noteName = (p, sym) => sym || base(p).replace(/\.(md|mdx)$/i, "");

// First line number from a "start-end" / "start" lines string (0 when absent).
function lineOf(lines) {
  const m = String(lines ?? "").match(/^\d+/);
  return m ? Number(m[0]) : 0;
}

// FROM-side node descriptor for an edge.
function fromNode(e) {
  if (NOTE_KINDS.has(e.kind)) {
    const name = noteName(e.from_path, e.from_symbol);
    return { id: `note:${name}`, label: `[[${name}]]`, cls: "note", ref: { path: e.from_path, line: lineOf(e.from_lines) } };
  }
  if (e.from_symbol) {
    return { id: `${e.from_symbol}\x00${e.from_path}`, label: `${e.from_symbol} · ${e.from_path}`, cls: "code", ref: { path: e.from_path, line: lineOf(e.from_lines) } };
  }
  return { id: e.from_path, label: e.from_path, cls: "code", ref: { path: e.from_path, line: lineOf(e.from_lines) } };
}

// TO-side node descriptor. Resolved → real target; non-resolved → named synthetic node
// keyed by ref_name (degrading to a shared "" sink when ref_name is null, i.e. a stale index).
function toNode(e) {
  if (e.conf === "resolved") {
    if (NOTE_KINDS.has(e.kind)) {
      const name = e.ref_name || e.to_symbol || base(e.to_path);
      return { id: `note:${name}`, label: `[[${name}]]`, cls: "note", ref: { path: e.to_path, line: 0 } };
    }
    if (e.to_symbol) {
      return { id: `${e.to_symbol}\x00${e.to_path}`, label: `${e.to_symbol} · ${e.to_path}`, cls: "code", ref: { path: e.to_path, line: lineOf(e.to_lines) } };
    }
    return { id: e.to_path, label: e.to_path, cls: "code", ref: { path: e.to_path, line: 0 } };
  }
  const name = e.ref_name || "";
  if (e.conf === "external") {
    return { id: `ext:${name}`, label: name || "(external)", cls: "external", ref: null, candidates: e.candidates };
  }
  return { id: `amb:${name}`, label: name || "(ambiguous)", cls: "ambiguous", ref: null, candidates: e.candidates };
}

// The symbol a node represents, for --focus matching: the function/import/note/target name,
// independent of the file it lives in.
function symbolOf(node) {
  const id = node.id;
  if (id.includes("\x00")) return id.split("\x00")[0];
  if (id.startsWith("ext:")) return id.slice(4);
  if (id.startsWith("amb:")) return id.slice(4);
  if (id.startsWith("note:")) return id.slice(5);
  return base(id); // bare file node
}

// Induced subgraph within `depth` undirected hops of every node whose symbol equals `focus`.
export function egoGraph({ nodes, edges }, focus, depth = 2) {
  const roots = nodes.filter((n) => symbolOf(n) === focus).map((n) => n.id);
  if (roots.length === 0) return { nodes: [], edges: [] };

  const adj = new Map();
  const link = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  for (const e of edges) { link(e.source, e.target); link(e.target, e.source); }

  const keep = new Set(roots);
  let frontier = roots;
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const id of frontier) for (const nb of adj.get(id) ?? []) if (!keep.has(nb)) { keep.add(nb); next.push(nb); }
    frontier = next;
    if (!frontier.length) break;
  }
  return {
    nodes: nodes.filter((n) => keep.has(n.id)),
    edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

// Keep only edges matching the kind / conf / pathPrefix filters (each optional).
// Operates on RAW edge rows (pre-mapEdges) — mapEdges drops from_path, so always filter first.
export function applyFilters(edges, { kind = null, conf = null, pathPrefix = null } = {}) {
  const kindSet = kind ? new Set(kind) : null;
  const confSet = conf ? new Set(conf) : null;
  return edges.filter((e) =>
    (!kindSet || kindSet.has(e.kind)) &&
    (!confSet || confSet.has(e.conf)) &&
    (!pathPrefix || String(e.from_path ?? "").startsWith(pathPrefix)));
}

// Cap node count by dropping the lowest-degree nodes (and their incident edges). Returns the
// graph plus { truncated, dropped }. Used only for the whole-repo view; focus is already bounded.
export function capByDegree({ nodes, edges }, maxNodes) {
  if (nodes.length <= maxNodes) return { nodes, edges, truncated: false, dropped: 0 };
  const degree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const keep = new Set(
    [...nodes].sort((a, b) => (degree.get(b.id) - degree.get(a.id)))
      .slice(0, maxNodes).map((n) => n.id));
  const keptNodes = nodes.filter((n) => keep.has(n.id));
  return {
    nodes: keptNodes,
    edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    truncated: true,
    dropped: nodes.length - keptNodes.length,
  };
}

// Confidence severity for rollup merges: ambiguous (a wrong guess) is the audit target, so it
// dominates; external (correctly outside the index) next; resolved is the baseline.
const SEVERITY = { resolved: 0, external: 1, ambiguous: 2 };
export function worstConf(a, b) { return SEVERITY[b] > SEVERITY[a] ? b : a; }

// Re-key code symbol nodes to their file; synthetic ext:/amb: and note: nodes pass through.
// Parallel edges merge by (source,target,kind), keeping the worst conf and summing a count
// used downstream as stroke width.
export function rollupToFiles({ nodes, edges }) {
  const fileId = (n) => (n.cls === "code" && n.id.includes("\x00")) ? n.id.split("\x00")[1] : n.id;
  const fileLabel = (n) => (n.cls === "code" && n.id.includes("\x00")) ? n.id.split("\x00")[1] : n.label;

  const out = new Map();
  for (const n of nodes) {
    const id = fileId(n);
    let cur = out.get(id);
    if (!cur) { cur = { id, label: fileLabel(n), cls: n.cls, refs: [], candidates: [] }; out.set(id, cur); }
    for (const r of n.refs) if (!cur.refs.some((x) => x.path === r.path && x.line === r.line)) cur.refs.push(r);
    for (const c of n.candidates) if (!cur.candidates.includes(c)) cur.candidates.push(c);
  }

  const idOf = new Map(nodes.map((n) => [n.id, fileId(n)]));
  const merged = new Map();
  for (const e of edges) {
    const s = idOf.get(e.source), t = idOf.get(e.target);
    if (s === t) continue; // self-loop after collapse — drop
    const key = `${s}\x00${t}\x00${e.kind}`;
    const cur = merged.get(key);
    if (cur) { cur.count += 1; cur.conf = worstConf(cur.conf, e.conf); }
    else merged.set(key, { source: s, target: t, kind: e.kind, conf: e.conf, count: 1 });
  }
  return { nodes: [...out.values()], edges: [...merged.values()] };
}

// Compose the pipeline: filter → map → (focus | cap) → optional rollup.
export function buildGraph(edges, opts = {}) {
  const { focus = null, depth = 2, rollup = false, kind = null, conf = null, pathPrefix = null, maxNodes = 400 } = opts;
  const rows = applyFilters(edges, { kind, conf, pathPrefix });
  let g = mapEdges(rows);
  let truncated = false, dropped = 0;

  if (focus) {
    g = egoGraph(g, focus, depth);
  } else {
    const capped = capByDegree(g, maxNodes);
    g = { nodes: capped.nodes, edges: capped.edges };
    truncated = capped.truncated; dropped = capped.dropped;
  }

  if (rollup) g = rollupToFiles(g);
  return { nodes: g.nodes, edges: g.edges, truncated, dropped };
}

// Map raw edge rows → { nodes: [...], edges: [...] }. Nodes are de-duped by id; each
// accumulates its source refs (for tooltips) and any candidate paths (ambiguous/external).
export function mapEdges(rows) {
  const nodes = new Map();
  const register = (d) => {
    let cur = nodes.get(d.id);
    if (!cur) { cur = { id: d.id, label: d.label, cls: d.cls, refs: [], candidates: [], _cand: new Set() }; nodes.set(d.id, cur); }
    if (d.ref && !cur.refs.some((r) => r.path === d.ref.path && r.line === d.ref.line)) cur.refs.push(d.ref);
    for (const c of d.candidates ?? []) if (!cur._cand.has(c)) { cur._cand.add(c); cur.candidates.push(c); }
    return cur.id;
  };
  const edges = rows.map((e) => {
    const source = register(fromNode(e));
    const target = register(toNode(e));
    return { source, target, kind: e.kind, conf: e.conf };
  });
  const out = [...nodes.values()];
  for (const n of out) delete n._cand;   // drop the transient dedup index
  return { nodes: out, edges };
}
