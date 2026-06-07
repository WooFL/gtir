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

// Keep only edges matching the kind / conf / pathPrefix filters (each optional).
export function applyFilters(edges, { kind = null, conf = null, pathPrefix = null } = {}) {
  const kindSet = kind ? new Set(kind) : null;
  const confSet = conf ? new Set(conf) : null;
  return edges.filter((e) =>
    (!kindSet || kindSet.has(e.kind)) &&
    (!confSet || confSet.has(e.conf)) &&
    (!pathPrefix || String(e.from_path ?? "").startsWith(pathPrefix)));
}

// Map raw edge rows → { nodes: [...], edges: [...] }. Nodes are de-duped by id; each
// accumulates its source refs (for tooltips) and any candidate paths (ambiguous/external).
export function mapEdges(rows) {
  const nodes = new Map();
  const register = (d) => {
    let cur = nodes.get(d.id);
    if (!cur) { cur = { id: d.id, label: d.label, cls: d.cls, refs: [], candidates: [] }; nodes.set(d.id, cur); }
    if (d.ref && !cur.refs.some((r) => r.path === d.ref.path && r.line === d.ref.line)) cur.refs.push(d.ref);
    for (const c of d.candidates ?? []) if (!cur.candidates.includes(c)) cur.candidates.push(c);
    return cur.id;
  };
  const edges = rows.map((e) => {
    const source = register(fromNode(e));
    const target = register(toNode(e));
    return { source, target, kind: e.kind, conf: e.conf };
  });
  return { nodes: [...nodes.values()], edges };
}
